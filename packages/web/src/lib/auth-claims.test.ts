import { describe, expect, it } from "vitest";
import { parseIdTokenClaims, principalFromClaims, principalFromIdToken } from "./auth-claims";

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
  token_use: "id",
  email: "ana@example.test",
};

describe("principal from the id token", () => {
  it("reads firmId, explicit role and groups", () => {
    const principal = principalFromIdToken(jwt({ ...base, "custom:firmId": "firm-delta", "custom:role": "BROKER", "cognito:groups": ["ANALYST"] }));
    expect(principal).toMatchObject({ sub: "sub-1", firmId: "firm-delta", role: "BROKER", groups: ["ANALYST"], expiresAt: 1_800_000_000_000 });
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

  it("rejects access tokens and malformed tokens", () => {
    expect(() => principalFromIdToken(jwt({ ...base, token_use: "access" }))).toThrow();
    expect(() => principalFromIdToken("not-a-jwt")).toThrow();
  });
});
