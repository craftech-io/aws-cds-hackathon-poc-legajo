import { describe, expect, it } from "vitest";
import { AUTH_REASON } from "./errors";
import { IdTokenClaims } from "./jwt";
import { consoleRolesOf, isSignInFresh, principalFromClaims } from "./principal";
import { createBrokerDirectory } from "./staff";

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

describe("principal", () => {
  it("takes firm and role from the token, the highest-precedence group when no role is stamped", () => {
    const principal = principalFromClaims(claims());
    expect(principal).toMatchObject({ firmId: "firm-delta", role: "BROKER", groups: ["BROKER", "ANALYST"], isJudge: false, authTime: NOW });
    expect(principalFromClaims(claims({ "custom:role": "ANALYST" })).role).toBe("ANALYST");
    expect(consoleRolesOf(["Admins", "JUDGE"])).toEqual(["JUDGE"]);
  });

  it("marks judge accounts", () => {
    expect(principalFromClaims(claims({ "cognito:groups": ["JUDGE"], "custom:firmId": "firm-judge-03" })).isJudge).toBe(true);
    expect(principalFromClaims(claims({ "custom:isJudge": "true" })).isJudge).toBe(true);
  });

  it("refuses a token without a firm or without a role", () => {
    expect(() => principalFromClaims(claims({ "custom:firmId": undefined }))).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
    expect(() => principalFromClaims(claims({ "custom:firmId": "Firm Delta" }))).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
    expect(() => principalFromClaims(claims({ "cognito:groups": [] }))).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
  });

  it("keeps the recent-login window at 15 minutes with 60 s of skew", () => {
    const at = (seconds: number) => new Date((NOW + seconds) * 1000);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60 + 1))).toBe(false);
    expect(isSignInFresh({ authTime: NOW }, at(-60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(-61))).toBe(false);
  });
});

describe("broker directory", () => {
  it("reads a broker once per minute and per user", async () => {
    let reads = 0;
    let now = Date.parse("2026-10-14T13:30:00Z");
    const directory = createBrokerDirectory(
      { findBySub: async (_firm, sub) => { reads += 1; return sub === "sub-1" ? { brokerId: "brk-01", active: true } : undefined; } },
      () => new Date(now),
    );
    expect(await directory.find("firm-delta", "sub-1")).toEqual({ brokerId: "brk-01", active: true });
    await directory.find("firm-delta", "sub-1");
    expect(reads).toBe(1);
    now += 60_000;
    await directory.find("firm-delta", "sub-1");
    expect(reads).toBe(2);
    expect(await directory.find("firm-delta", "sub-2")).toBeUndefined();
  });
});
