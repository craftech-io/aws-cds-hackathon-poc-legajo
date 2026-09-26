import { describe, expect, it } from "vitest";
import { displayNameOf, parseIdTokenClaims, principalFromClaims, principalFromIdToken, signInNameOf } from "./auth-claims";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", kid: "k" })}.${encode(payload)}.signature`;
}

const base = {
  sub: "sub-1",
  iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x",
  aud: "client",
  exp: 1_800_000_000,
  iat: 1_799_996_400,
  auth_time: 1_799_996_400,
  token_use: "id",
  email: "diego.ferreyra@example.test",
  "cognito:username": "a1b2c3",
};

describe("principal from the id token", () => {
  it("reads firmId, explicit role, groups, username and the sign-in time", () => {
    const principal = principalFromIdToken(jwt({ ...base, "custom:firmId": "firm-delta", "custom:role": "BROKER", "cognito:groups": ["ANALYST"] }));
    expect(principal).toMatchObject({
      sub: "sub-1",
      username: "a1b2c3",
      firmId: "firm-delta",
      role: "BROKER",
      groups: ["ANALYST"],
      isJudge: false,
      authTime: 1_799_996_400_000,
      expiresAt: 1_800_000_000_000,
    });
  });

  it("falls back to the highest-precedence group and drops unknown groups", () => {
    const principal = principalFromClaims(parseIdTokenClaims(jwt({ ...base, "cognito:groups": ["ANALYST", "custom-thing", "BROKER"] })));
    expect(principal.role).toBe("BROKER");
    expect(principal.groups).toEqual(["BROKER", "ANALYST"]);
    expect(principal.firmId).toBeUndefined();
  });

  it("ignores an invalid custom:role and leaves role undefined without groups", () => {
    const principal = principalFromIdToken(jwt({ ...base, "custom:role": "ROOT" }));
    expect(principal.role).toBeUndefined();
  });

  it("treats a firm id that is not firm-<slug> as no firm", () => {
    expect(principalFromIdToken(jwt({ ...base, "custom:firmId": "Estudio Delta" })).firmId).toBeUndefined();
    expect(principalFromIdToken(jwt({ ...base, "custom:firmId": "firm-judge-01" })).firmId).toBe("firm-judge-01");
  });

  it("marks a judge by role or by the pre-token flag, and names it by its username", () => {
    const judge = principalFromIdToken(jwt({ ...base, email: undefined, "cognito:username": "judge-01", "cognito:groups": ["JUDGE"], "custom:firmId": "firm-judge-01" }));
    expect(judge).toMatchObject({ role: "JUDGE", isJudge: true });
    expect(signInNameOf(judge)).toBe("judge-01");
    expect(displayNameOf(judge)).toBe("judge-01");
    expect(principalFromIdToken(jwt({ ...base, "custom:isJudge": "true", "cognito:groups": ["BROKER"] })).isJudge).toBe(true);
  });

  it("prefers the email to sign in again and the name to show", () => {
    const principal = principalFromIdToken(jwt({ ...base, name: "Diego Ferreyra" }));
    expect(signInNameOf(principal)).toBe("diego.ferreyra@example.test");
    expect(displayNameOf(principal)).toBe("Diego Ferreyra");
  });

  it("rejects access tokens and malformed tokens", () => {
    expect(() => principalFromIdToken(jwt({ ...base, token_use: "access" }))).toThrow();
    expect(() => principalFromIdToken("not-a-jwt")).toThrow();
  });
});
