import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_REASON } from "../auth/errors";
import { IdTokenClaims } from "../auth/jwt";
import { principalFromClaims } from "../auth/principal";
import { brokerLookupOf } from "../auth/staff";
import { seedBrokers } from "../auth/testing";
import { memoryStores } from "../connector/testing";
import { createLogger } from "../lib/log";
import { ACCOUNT_ADMIN_SCOPE, type ClaimsAndScopeOverrideDetails, createPreTokenHandler, type PreTokenDeps } from "./pre-token";

const DIEGO = "0b7f0e2e-0000-4000-8000-000000000001";
const MARTINA = "0b7f0e2e-0000-4000-8000-000000000002";
const GUEST = "0b7f0e2e-0000-4000-8000-000000000003";
const GONE = "0b7f0e2e-0000-4000-8000-00000000dead";
const PABLO = "0b7f0e2e-0000-4000-8000-000000000004";

interface EventInput {
  readonly sub?: string;
  readonly firmId?: string;
  readonly groups?: readonly string[];
  readonly triggerSource?: string;
}

// A V2_0 event as Cognito sends it (docs: "Pre token generation Lambda trigger", version two).
function cognitoEvent({ sub = DIEGO, firmId = "firm-delta", groups = ["BROKER"], triggerSource = "TokenGeneration_Authentication" }: EventInput = {}) {
  return {
    version: "2",
    triggerSource,
    region: "us-east-1",
    userPoolId: "us-east-1_TESTPOOL1",
    userName: "b7f0e2e1",
    callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "test-web-client" },
    request: {
      userAttributes: { sub, "cognito:user_status": "CONFIRMED", email: "diego.ferreyra@sim.legajo.demo.craftech.io", email_verified: "true", ...(firmId === "" ? {} : { "custom:firmId": firmId }) },
      groupConfiguration: { groupsToOverride: [...groups], iamRolesToOverride: [], preferredRole: null },
      scopes: ["aws.cognito.signin.user.admin"],
    },
    response: { claimsAndScopeOverrideDetails: null },
  };
}

interface TriggerResult {
  readonly callerContext: unknown;
  readonly response: { readonly claimsAndScopeOverrideDetails: ClaimsAndScopeOverrideDetails };
}

const REFUSED = {
  idTokenGeneration: { claimsToSuppress: ["custom:firmId"] },
  groupOverrideDetails: { groupsToOverride: [] },
};

describe("Cognito pre token generation (V2_0)", () => {
  let lines: string[];
  let deps: PreTokenDeps;
  let run: (event: unknown) => Promise<TriggerResult>;

  beforeEach(async () => {
    const stores = memoryStores();
    await seedBrokers(stores, [
      { firmId: "firm-delta", brokerId: "brk-delta-diego", role: "BROKER", sub: DIEGO },
      { firmId: "firm-delta", brokerId: "brk-delta-martina", role: "ANALYST", sub: MARTINA },
      { firmId: "firm-delta", brokerId: "brk-delta-gone", role: "BROKER", sub: GONE, active: false },
      { firmId: "firm-norte", brokerId: "brk-norte-pablo", role: "BROKER", sub: PABLO },
    ]);
    lines = [];
    deps = { brokers: brokerLookupOf(stores.connector.firms), log: createLogger({ level: "debug", sink: (line) => void lines.push(line) }) };
    const handler = createPreTokenHandler(() => deps);
    run = async (event) => (await handler(event)) as TriggerResult;
  });

  it("stamps firm, the broker row's role and isGuest, and hands the groups back unchanged", async () => {
    const event = cognitoEvent();
    const result = await run(event);
    expect(result.response.claimsAndScopeOverrideDetails).toEqual({
      idTokenGeneration: { claimsToAddOrOverride: { "custom:firmId": "firm-delta", "custom:role": "BROKER", "custom:isGuest": "false" } },
      groupOverrideDetails: event.request.groupConfiguration,
    });
    // The rest of the event travels back as Cognito sent it.
    expect(result.callerContext).toEqual(event.callerContext);
  });

  it("prefers the broker row over the groups, on sign-in and on refresh", async () => {
    for (const triggerSource of ["TokenGeneration_Authentication", "TokenGeneration_RefreshTokens", "TokenGeneration_NewPasswordChallenge"]) {
      const result = await run(cognitoEvent({ sub: MARTINA, groups: ["BROKER"], triggerSource }));
      expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration.claimsToAddOrOverride).toMatchObject({ "custom:role": "ANALYST" });
    }
  });

  it("stamps a guest from its group on the first sign-in, before its world and broker row exist", async () => {
    const result = await run(cognitoEvent({ sub: GUEST, firmId: "firm-guest-01", groups: ["GUEST"] }));
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration.claimsToAddOrOverride).toEqual({
      "custom:firmId": "firm-guest-01",
      "custom:role": "GUEST",
      "custom:isGuest": "true",
    });
  });

  it("takes the account self-service scope out of every guest access token, and only a guest's", async () => {
    for (const triggerSource of ["TokenGeneration_Authentication", "TokenGeneration_RefreshTokens"]) {
      const guest = (await run(cognitoEvent({ sub: GUEST, firmId: "firm-guest-01", groups: ["GUEST"], triggerSource }))).response.claimsAndScopeOverrideDetails;
      expect(guest.accessTokenGeneration).toEqual({ scopesToSuppress: [ACCOUNT_ADMIN_SCOPE] });
    }
    expect(ACCOUNT_ADMIN_SCOPE).toBe("aws.cognito.signin.user.admin");
    for (const sub of [DIEGO, MARTINA]) {
      expect((await run(cognitoEvent({ sub }))).response.claimsAndScopeOverrideDetails).not.toHaveProperty("accessTokenGeneration");
    }
  });

  it("never takes the role from a broker row of another firm", async () => {
    const result = await run(cognitoEvent({ sub: PABLO, firmId: "firm-delta", groups: ["ANALYST"] }));
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration.claimsToAddOrOverride).toMatchObject({ "custom:firmId": "firm-delta", "custom:role": "ANALYST" });
  });

  it.each([
    ["an inactive broker", { sub: GONE }, "BROKER_INACTIVE"],
    ["no firm", { firmId: "" }, "NO_FIRM"],
    ["a firm id that is not firm-<slug>", { firmId: "Estudio Delta" }, "NO_FIRM"],
    ["no console group and no broker row", { sub: GUEST, groups: ["Admins"] }, "NO_ROLE"],
    ["a guest outside a guest firm", { sub: GUEST, firmId: "firm-delta", groups: ["GUEST"] }, "GUEST_OUTSIDE_GUEST_FIRM"],
    ["no sub", { sub: "" }, "NO_SUB"],
  ])("issues a token without tenant, role or groups for %s", async (_label, input, refusal) => {
    const result = await run(cognitoEvent(input));
    expect(result.response.claimsAndScopeOverrideDetails).toEqual(REFUSED);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ message: "auth.pretoken.refused", refusal }));
  });

  it("produces tokens the BFF reads back as the same principal, and refused ones it rejects", async () => {
    const base = { sub: DIEGO, iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL1", aud: "test-web-client", token_use: "id", exp: 2, iat: 1, auth_time: 1, "cognito:username": "b7f0e2e1" };
    const stamped = (await run(cognitoEvent({ sub: MARTINA }))).response.claimsAndScopeOverrideDetails;
    const claims = IdTokenClaims.parse({ ...base, ...stamped.idTokenGeneration.claimsToAddOrOverride, "cognito:groups": stamped.groupOverrideDetails.groupsToOverride });
    expect(principalFromClaims(claims)).toMatchObject({ firmId: "firm-delta", role: "ANALYST", isGuest: false });

    // What Cognito would issue for the inactive broker: its attributes minus the suppressed ones, the overridden groups.
    const refused = (await run(cognitoEvent({ sub: GONE }))).response.claimsAndScopeOverrideDetails;
    const suppressed = new Set(refused.idTokenGeneration.claimsToSuppress);
    const issued = Object.fromEntries(Object.entries({ ...base, "custom:firmId": "firm-delta" }).filter(([claim]) => !suppressed.has(claim)));
    const refusedClaims = IdTokenClaims.parse({ ...issued, ...refused.idTokenGeneration.claimsToAddOrOverride, "cognito:groups": refused.groupOverrideDetails.groupsToOverride });
    expect(() => principalFromClaims(refusedClaims)).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
  });

  it("fails the sign-in when the broker directory cannot be read, or not within its deadline", async () => {
    deps = { ...deps, brokers: { findBySub: () => Promise.reject(new Error("Firms is throttled")) } };
    await expect(run(cognitoEvent())).rejects.toThrow("could not resolve the console access of this user");
    deps = { ...deps, brokers: { findBySub: () => new Promise(() => undefined) }, lookupTimeoutMs: 20 };
    await expect(run(cognitoEvent())).rejects.toThrow("could not resolve the console access of this user");
    expect(lines.filter((line) => line.includes("auth.pretoken.lookup_failed"))).toHaveLength(2);
  });

  it("rejects an event that is not a pre token generation event", async () => {
    await expect(run({ version: "2", request: {} })).rejects.toThrow("unexpected shape");
  });

  it("never logs the user's name, email or sub", async () => {
    await run(cognitoEvent());
    await run(cognitoEvent({ sub: GONE }));
    const logged = lines.join("\n");
    for (const personal of ["b7f0e2e1", "diego.ferreyra", DIEGO, GONE]) expect(logged).not.toContain(personal);
    expect(logged).toContain("auth.pretoken.stamped");
  });
});
