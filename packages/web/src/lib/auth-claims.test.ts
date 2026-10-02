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
      isGuest: false,
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
    expect(principalFromIdToken(jwt({ ...base, "custom:firmId": "firm-guest-01" })).firmId).toBe("firm-guest-01");
  });

  it("marks a guest by role or by the pre-token flag, and names it by its username", () => {
    const guest = principalFromIdToken(jwt({ ...base, email: undefined, "cognito:username": "guest-01", "cognito:groups": ["GUEST"], "custom:firmId": "firm-guest-01" }));
    expect(guest).toMatchObject({ role: "GUEST", isGuest: true });
    expect(signInNameOf(guest)).toBe("guest-01");
    expect(displayNameOf(guest)).toBe("guest-01");
    expect(principalFromIdToken(jwt({ ...base, "custom:isGuest": "true", "cognito:groups": ["BROKER"] })).isGuest).toBe(true);
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
