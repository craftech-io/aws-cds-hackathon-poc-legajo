// AuthPreToken for guests (ADR-0015 §4, FL-105): a GUEST's firm and world lease come only from its own
// broker row; without a row, its token has no firm and only `guestBootstrapProcedure` accepts it; with
// the row (written when its world is READY), the next refresh stamps firm and lease, and the BFF reads
// them back as the principal that the fail-closed check of every firm procedure compares.
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_REASON } from "../auth/errors";
import { IdTokenClaims } from "../auth/jwt";
import { guestFromClaims, principalFromClaims } from "../auth/principal";
import { brokerLookupOf } from "../auth/staff";
import { seedBrokers } from "../auth/testing";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { createLogger } from "../lib/log";
import { ACCOUNT_ADMIN_SCOPE, type ClaimsAndScopeOverrideDetails, createPreTokenHandler, guestRowsOf } from "./pre-token";

const SUB = "5a1d0c3e-0000-4000-8000-000000000041";
let stores: MemoryStores;

beforeEach(() => {
  stores = memoryStores();
});

async function stamp(attributes: Record<string, string> = {}, groups: string[] = ["GUEST"]): Promise<ClaimsAndScopeOverrideDetails> {
  const handler = createPreTokenHandler(() => ({ brokers: brokerLookupOf(stores.connector.firms), guestRows: guestRowsOf(stores.client), log: createLogger({ level: "error" }) }));
  const event = {
    version: "2",
    triggerSource: "TokenGeneration_RefreshTokens",
    userPoolId: "us-east-1_TESTPOOL1",
    userName: "usr-01j9zq00000000000000000001",
    request: { userAttributes: { sub: SUB, email: "ana.gomez@despachos-del-sur.com.ar", ...attributes }, groupConfiguration: { groupsToOverride: groups, iamRolesToOverride: [], preferredRole: null } },
    response: { claimsAndScopeOverrideDetails: null },
  };
  return ((await handler(event)) as { response: { claimsAndScopeOverrideDetails: ClaimsAndScopeOverrideDetails } }).response.claimsAndScopeOverrideDetails;
}

function claimsOf(details: ClaimsAndScopeOverrideDetails, attributes: Record<string, string> = {}) {
  const suppressed = new Set(details.idTokenGeneration.claimsToSuppress);
  const issued = Object.fromEntries(Object.entries({ sub: SUB, iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL1", aud: "test-web-client", token_use: "id", exp: 2, iat: 1, auth_time: 1, "cognito:username": "usr-01j9zq00000000000000000001", email: "ana.gomez@despachos-del-sur.com.ar", ...attributes }).filter(([claim]) => !suppressed.has(claim)));
  return IdTokenClaims.parse({ ...issued, ...details.idTokenGeneration.claimsToAddOrOverride, "cognito:groups": details.groupOverrideDetails.groupsToOverride });
}

describe("[FL-105] a public guest's token", () => {
  it("before its world: no firm, guest role, no account scope; only the bootstrap accepts it", async () => {
    const details = await stamp();
    expect(details.idTokenGeneration).toEqual({ claimsToAddOrOverride: { "custom:role": "GUEST", "custom:isGuest": "true" }, claimsToSuppress: ["custom:firmId"] });
    expect(details.accessTokenGeneration).toEqual({ scopesToSuppress: [ACCOUNT_ADMIN_SCOPE] });
    const claims = claimsOf(details);
    expect(() => principalFromClaims(claims)).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
    expect(guestFromClaims(claims)).toMatchObject({ sub: SUB, email: "ana.gomez@despachos-del-sur.com.ar" });
    expect(guestFromClaims(claims)).not.toHaveProperty("firmId");
  });

  it("with its world's broker row: the row's firm and lease, read back as the principal", async () => {
    await seedBrokers(stores, [{ firmId: "firm-guest-41", brokerId: "brk-guest-41", role: "GUEST", sub: SUB }]);
    await stores.client.update("Firms", { PK: "FIRM#firm-guest-41", SK: "BROKER#brk-guest-41" }, { set: { leaseId: "lease-1" } }, new Date().toISOString());
    const details = await stamp();
    expect(details.idTokenGeneration.claimsToAddOrOverride).toEqual({ "custom:firmId": "firm-guest-41", "custom:role": "GUEST", "custom:isGuest": "true", "custom:worldLease": "lease-1" });
    expect(principalFromClaims(claimsOf(details))).toMatchObject({ firmId: "firm-guest-41", role: "GUEST", isGuest: true, worldLease: "lease-1" });
  });

  it("never takes the firm from the user attribute, only from the row", async () => {
    const details = await stamp({ "custom:firmId": "firm-guest-07" });
    expect(details.idTokenGeneration.claimsToSuppress).toEqual(["custom:firmId"]);
    expect(guestFromClaims(claimsOf(details, { "custom:firmId": "firm-guest-07" }))).not.toHaveProperty("firmId");
  });

  it("an inactive row or two rows of one guest give a token with no access", async () => {
    await seedBrokers(stores, [{ firmId: "firm-guest-41", brokerId: "brk-guest-41", role: "GUEST", sub: SUB, active: false }]);
    expect((await stamp()).groupOverrideDetails).toEqual({ groupsToOverride: [] });
    await seedBrokers(stores, [
      { firmId: "firm-guest-41", brokerId: "brk-guest-41", role: "GUEST", sub: SUB },
      { firmId: "firm-guest-42", brokerId: "brk-guest-42", role: "GUEST", sub: SUB },
    ]);
    expect((await stamp()).groupOverrideDetails).toEqual({ groupsToOverride: [] });
  });
});
