// The Lambda entry of the BFF verifies id tokens only against the keys its user pool publishes:
// nothing in a request (headers, query, body, the token's own `jku`/`jwk`/`x5u`), in the environment
// or in the linked resources can hand it another key set. Only a local entry point (the Playwright UI
// server) pins an ephemeral JWKS, through the `jwks` option this entry never passes
// (docs/test-plan.md §2, level UI).
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_REASON } from "./errors";
import { TEST_JWKS_URI, TEST_POOL, createTestIssuer } from "./testing";

const state = vi.hoisted(() => ({ requested: [] as string[], served: "" }));

vi.mock("sst", () => ({
  Resource: new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "Auth") {
          return { userPoolId: "us-east-1_TESTPOOL1", clientId: "test-web-client", issuerUrl: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL1", region: "us-east-1" };
        }
        throw new Error(`"${String(property)}" is not linked`);
      },
    },
  ),
}));

// The network of the verifier: records every URI and serves the pool's keys.
vi.mock("aws-jwt-verify/https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("aws-jwt-verify/https")>();
  return {
    ...actual,
    fetch: async (uri: string) => {
      state.requested.push(uri);
      const bytes = new TextEncoder().encode(state.served);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
});

vi.mock("./jwt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jwt")>();
  return { ...actual, createCognitoIdTokenVerifier: vi.fn(actual.createCognitoIdTokenVerifier) };
});

const jwt = await import("./jwt");
const { createContext } = await import("../routers/trpc");
const { resetDefaultDeps } = await import("../routers/deps");
const handlerModule = await import("../routers/handler");

const pool = createTestIssuer();
// Same `kid` as the pool's key, another private key: what a forger would try.
const forger = createTestIssuer({ kid: pool.kid });
state.served = JSON.stringify(pool.jwks);

const INJECTION_HEADERS = {
  "x-jwks": JSON.stringify(forger.jwks),
  "x-jwks-uri": "https://keys.attacker.invalid/jwks.json",
  "x-amz-cognito-issuer": "https://keys.attacker.invalid",
  jwks_uri: "https://keys.attacker.invalid/jwks.json",
};

function eventWith(token: string) {
  return {
    headers: { authorization: `Bearer ${token}`, ...INJECTION_HEADERS },
    requestContext: { requestId: "req-no-jwks-0001" },
    rawQueryString: `jwks_uri=${encodeURIComponent("https://keys.attacker.invalid/jwks.json")}`,
    body: JSON.stringify({ jwks: forger.jwks }),
  };
}

describe("[FL-079] the Lambda's verifier cannot be handed another key set", () => {
  beforeEach(() => {
    resetDefaultDeps();
    state.requested.length = 0;
    vi.mocked(jwt.createCognitoIdTokenVerifier).mockClear();
    vi.unstubAllEnvs();
  });

  it("builds its only verifier from the Auth link, with no options", async () => {
    const context = await createContext({ event: eventWith(pool.idToken()) });
    expect(context.principal).toMatchObject({ firmId: "firm-delta", role: "BROKER" });
    const calls = vi.mocked(jwt.createCognitoIdTokenVerifier).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([{ userPoolId: TEST_POOL.userPoolId, clientId: TEST_POOL.clientId, issuerUrl: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL1", region: "us-east-1" }]);
  });

  it("rejects a forged token whatever the request carries, and fetches keys only from the pool", async () => {
    const forgedHeaders = [{}, { jku: "https://keys.attacker.invalid/jwks.json" }, { jwk: forger.jwks.keys[0] }, { x5u: "https://keys.attacker.invalid/cert.pem" }];
    for (const header of forgedHeaders) {
      const context = await createContext({ event: eventWith(forger.idToken({}, header)) });
      expect(context.principal).toBeNull();
      expect(context.authFailure?.reason).toBe(AUTH_REASON.TOKEN_INVALID);
    }
    const unknownKid = createTestIssuer({ kid: "attacker-key" });
    const context = await createContext({ event: eventWith(unknownKid.idToken()) });
    expect(context.authFailure?.reason).toBe(AUTH_REASON.TOKEN_INVALID);
    expect(state.requested.length).toBeGreaterThan(0);
    expect(new Set(state.requested)).toEqual(new Set([TEST_JWKS_URI]));
  });

  it("ignores environment variables that name another pool or key set", async () => {
    vi.stubEnv("JWKS_URI", "https://keys.attacker.invalid/jwks.json");
    vi.stubEnv("COGNITO_USER_POOL_ID", "us-east-1_ATTACKER1");
    vi.stubEnv("AUTH_JWKS", JSON.stringify(forger.jwks));
    expect((await createContext({ event: eventWith(forger.idToken()) })).authFailure?.reason).toBe(AUTH_REASON.TOKEN_INVALID);
    expect((await createContext({ event: eventWith(pool.idToken()) })).principal?.firmId).toBe("firm-delta");
    expect(new Set(state.requested)).toEqual(new Set([TEST_JWKS_URI]));
  });

  it("exports only the handler and the pieces it is built from; none of them reads keys from the event", () => {
    expect(Object.keys(handlerModule).sort()).toEqual(["API_PREFIX", "createHandler", "handler", "stripApiPrefix"]);
    // The entry's module chain never reads the environment nor pins keys.
    for (const file of ["../routers/handler.ts", "../routers/trpc.ts", "../routers/deps.ts", "./config.ts"]) {
      const code = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/process\.env|cacheJwks|\bjwks\s*:|\bfetcher\s*:/);
    }
  });
});

describe("[FL-079] pinned key set of a local entry point", () => {
  it("verifies offline and turns a token of another key into TOKEN_INVALID without any fetch", async () => {
    state.requested.length = 0;
    const local = createTestIssuer({ kid: "ui-server-key" });
    const verifier = jwt.createCognitoIdTokenVerifier(TEST_POOL, { jwks: local.jwks });
    expect((await verifier.verify(local.idToken())).sub).toBe("7f1c9d2e-0000-4000-8000-000000000001");
    await expect(verifier.verify(pool.idToken())).rejects.toMatchObject({ reason: AUTH_REASON.TOKEN_INVALID });
    await expect(verifier.verify(forger.idToken({}, { kid: "ui-server-key" }))).rejects.toMatchObject({ reason: AUTH_REASON.TOKEN_INVALID });
    expect(state.requested).toEqual([]);
  });
});
