import { describe, expect, it } from "vitest";
import { memoryStores } from "../connector/testing";
import { AUTH_REASON } from "./errors";
import { IdTokenClaims } from "./jwt";
import { QA_PRINCIPAL, consoleRolesOf, isJudgeFirm, isSignInFresh, principalFromClaims, qaPrincipal, resolveAccess, withBrokerRow } from "./principal";
import { brokerLookupOf, createBrokerDirectory } from "./staff";
import { seedBrokers } from "./testing";

const NOW = Math.floor(Date.parse("2026-10-14T13:30:00Z") / 1000);

function claims(overrides: Record<string, unknown> = {}): IdTokenClaims {
  return IdTokenClaims.parse({
    sub: "sub-1",
    iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL1",
    aud: "client",
    token_use: "id",
    exp: NOW + 900,
    iat: NOW,
    auth_time: NOW,
    "cognito:username": "sub-1",
    "cognito:groups": ["ANALYST", "BROKER"],
    "custom:firmId": "firm-delta",
    ...overrides,
  });
}

const incomplete = expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE });

describe("principal", () => {
  it("takes firm and role from the token, the highest-precedence group when no role is stamped", () => {
    const principal = principalFromClaims(claims());
    expect(principal).toMatchObject({ firmId: "firm-delta", role: "BROKER", groups: ["BROKER", "ANALYST"], isJudge: false, authTime: NOW });
    expect(principal.brokerId).toBeUndefined();
    expect(principalFromClaims(claims({ "custom:role": "ANALYST" })).role).toBe("ANALYST");
    expect(consoleRolesOf(["Admins", "JUDGE"])).toEqual(["JUDGE"]);
  });

  it("marks judge accounts, only inside a judge firm", () => {
    expect(principalFromClaims(claims({ "cognito:groups": ["JUDGE"], "custom:firmId": "firm-judge-03" })).isJudge).toBe(true);
    expect(principalFromClaims(claims({ "custom:isJudge": "true", "custom:firmId": "firm-judge-test" })).isJudge).toBe(true);
    expect(() => principalFromClaims(claims({ "cognito:groups": ["JUDGE"] }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ "custom:isJudge": "true" }))).toThrowError(incomplete);
    expect(isJudgeFirm("firm-judge-01")).toBe(true);
    expect(isJudgeFirm("firm-delta")).toBe(false);
  });

  it("refuses a token without a firm or without a role", () => {
    expect(() => principalFromClaims(claims({ "custom:firmId": undefined }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ "custom:firmId": "Firm Delta" }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ "cognito:groups": [] }))).toThrowError(incomplete);
    expect(resolveAccess({ firmId: "firm-delta", role: "ROOT", groups: ["Admins"] })).toEqual({ ok: false, refusal: "NO_ROLE" });
  });

  it("lets a fresher broker row set the broker id and the role, and refuses an inactive broker", () => {
    const principal = principalFromClaims(claims());
    expect(withBrokerRow(principal, undefined)).toBe(principal);
    expect(withBrokerRow(principal, { brokerId: "brk-delta-diego", role: "ANALYST", active: true })).toMatchObject({ brokerId: "brk-delta-diego", role: "ANALYST", firmId: "firm-delta" });
    expect(() => withBrokerRow(principal, { brokerId: "brk-delta-diego", role: "BROKER", active: false })).toThrowError(expect.objectContaining({ reason: AUTH_REASON.BROKER_INACTIVE }));
    expect(() => withBrokerRow(principal, { brokerId: "brk-delta-diego", role: "JUDGE", active: true })).toThrowError(incomplete);
  });

  it("keeps the recent-login window at 15 minutes with 60 s of skew", () => {
    const at = (seconds: number) => new Date((NOW + seconds) * 1000);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60 + 1))).toBe(false);
    expect(isSignInFresh({ authTime: NOW }, at(-60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(-61))).toBe(false);
  });

  it("builds the QaDriver's principal on the server: firm-qa, BROKER or ANALYST, configurable sign-in", () => {
    const now = new Date(NOW * 1000);
    expect(qaPrincipal({ role: "BROKER", now })).toEqual({
      sub: QA_PRINCIPAL.sub,
      username: QA_PRINCIPAL.sub,
      firmId: "firm-qa",
      role: "BROKER",
      groups: ["BROKER"],
      isJudge: false,
      authTime: NOW,
      brokerId: "brk-qa-runner",
    });
    expect(qaPrincipal({ role: "ANALYST", now, authTime: new Date((NOW - 3600) * 1000) })).toMatchObject({ brokerId: "brk-qa-analyst", authTime: NOW - 3600 });
    expect(() => qaPrincipal({ role: "JUDGE" as never, now })).toThrow();
  });
});

describe("broker directory", () => {
  it("reads a broker once per minute and per user", async () => {
    let reads = 0;
    let now = Date.parse("2026-10-14T13:30:00Z");
    const directory = createBrokerDirectory(
      {
        findBySub: async (_firm, sub) => {
          reads += 1;
          return sub === "sub-1" ? { brokerId: "brk-01", role: "BROKER", active: true } : undefined;
        },
      },
      () => new Date(now),
    );
    expect(await directory.find("firm-delta", "sub-1")).toEqual({ brokerId: "brk-01", role: "BROKER", active: true });
    await directory.find("firm-delta", "sub-1");
    expect(reads).toBe(1);
    now += 60_000;
    await directory.find("firm-delta", "sub-1");
    expect(reads).toBe(2);
    expect(await directory.find("firm-delta", "sub-2")).toBeUndefined();
  });

  it("matches a sub only against the broker rows of its own firm", async () => {
    const stores = memoryStores();
    await seedBrokers(stores, [
      { firmId: "firm-delta", brokerId: "brk-delta-diego", role: "BROKER", sub: "sub-diego" },
      { firmId: "firm-norte", brokerId: "brk-norte-pablo", role: "BROKER", sub: "sub-pablo", active: false },
    ]);
    const lookup = brokerLookupOf(stores.connector.firms);
    expect(await lookup.findBySub("firm-delta", "sub-diego")).toEqual({ brokerId: "brk-delta-diego", role: "BROKER", active: true });
    expect(await lookup.findBySub("firm-norte", "sub-diego")).toBeUndefined();
    expect(await lookup.findBySub("firm-norte", "sub-pablo")).toEqual({ brokerId: "brk-norte-pablo", role: "BROKER", active: false });
  });
});
