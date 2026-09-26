// Verifies the Cognito id token the console sends on every call, offline: RS256 signature against
// the pool's JWKS (fetched once per container from `<issuer>/.well-known/jwks.json` and cached),
// issuer, audience (the web client id), `token_use = id` and expiry. The library is AWS's own
// verifier; this module only adds the timeout and backoff every external call carries and turns its
// errors into `AuthError` so the edge can tell "bad token" from "Cognito is down".
//
// The keys are never negotiable by a request: the JWKS URI derives from the pool id of the `Auth`
// link, the token's own `jku`/`jwk`/`x5u` headers are ignored, and the Lambda entry
// (routers/handler.ts → routers/deps.ts) builds this verifier with no options at all. Only a local
// entry point (the UI server of the Playwright tests) passes `jwks`, which pins an ephemeral key set
// and turns the network off (auth/no-jwks-override.test.ts).
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { FetchError, JwtBaseError, JwtExpiredError, NonRetryableFetchError } from "aws-jwt-verify/error";
import { fetch as fetchJwks, type Fetcher } from "aws-jwt-verify/https";
import { type Jwks, SimpleJwksCache } from "aws-jwt-verify/jwk";
import { z } from "zod";
import { withRetry } from "../lib/retry";
import { AUTH_REASON, AuthError } from "./errors";

/** Claims the BFF reads. Everything else in the token is ignored, never trusted by name. */
export const IdTokenClaims = z.looseObject({
  sub: z.string().min(1),
  iss: z.string().min(1),
  aud: z.string().min(1),
  token_use: z.literal("id"),
  exp: z.number().int(),
  iat: z.number().int(),
  // Epoch seconds of the last interactive sign-in; a refresh does not move it.
  auth_time: z.number().int(),
  // Id of the sign-in the token descends from; a refresh keeps it (one session per judge world).
  origin_jti: z.string().min(1).max(128).optional(),
  "cognito:username": z.string().min(1),
  "cognito:groups": z.array(z.string()).optional(),
  // Set by the invitation (custom:firmId) and by the pre-token trigger (role, isJudge).
  "custom:firmId": z.string().optional(),
  "custom:role": z.string().optional(),
  "custom:isJudge": z.enum(["true", "false"]).optional(),
  email: z.string().optional(),
  name: z.string().optional(),
});
export type IdTokenClaims = z.infer<typeof IdTokenClaims>;

export interface IdTokenVerifier {
  /** Resolves with the verified claims or rejects with an `AuthError`. */
  verify(token: string): Promise<IdTokenClaims>;
}

export interface IdTokenVerifierConfig {
  readonly userPoolId: string;
  readonly clientId: string;
}

export interface IdTokenVerifierOptions {
  /** Test seam: serves the JWKS instead of the network. */
  readonly fetcher?: Fetcher;
  /**
   * Local entry points only (never the Lambda): the key set to trust, cached up front with the
   * verifier's own `cacheJwks`. Without a `fetcher`, the network is off: a token naming another
   * `kid` fails as TOKEN_INVALID instead of reaching Cognito.
   */
  readonly jwks?: Jwks;
}

// The JWKS is a small static document behind Cognito's CDN. It is fetched once per container and
// again only when a token names an unknown `kid` (key rotation), so a short deadline is safe.
const JWKS_SOCKET_IDLE_MS = 1_500;
const JWKS_RESPONSE_TIMEOUT_MS = 3_000;
const JWKS_ATTEMPTS = 3;

class BackoffFetcher implements Fetcher {
  fetch(uri: string, requestOptions?: Record<string, unknown>, data?: ArrayBuffer): Promise<ArrayBuffer> {
    const options = { timeout: JWKS_SOCKET_IDLE_MS, responseTimeout: JWKS_RESPONSE_TIMEOUT_MS, ...requestOptions };
    return withRetry(() => fetchJwks(uri, options, data), {
      attempts: JWKS_ATTEMPTS,
      baseDelayMs: 100,
      shouldRetry: (error) => error instanceof FetchError && !(error instanceof NonRetryableFetchError),
    });
  }
}

function toAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  if (error instanceof JwtExpiredError) return new AuthError(AUTH_REASON.TOKEN_EXPIRED, "id token expired", { cause: error });
  if (error instanceof FetchError) return new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "could not fetch the signing keys", { cause: error });
  if (error instanceof JwtBaseError || error instanceof z.ZodError) {
    return new AuthError(AUTH_REASON.TOKEN_INVALID, "id token rejected", { cause: error });
  }
  // Anything unexpected fails closed as an outage, not as a verdict on the token.
  return new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "id token could not be verified", { cause: error });
}

/** A JWKS document as the `ArrayBuffer` a `Fetcher` answers. */
export function jwksBuffer(jwks: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(jwks));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// A pinned key set never goes to the network: a refetch for an unknown `kid` gets the same keys
// back, so the token fails as TOKEN_INVALID.
function pinnedFetcher(jwks: Jwks): Fetcher {
  return { fetch: async () => jwksBuffer(jwks) };
}

export function createCognitoIdTokenVerifier(config: IdTokenVerifierConfig, options: IdTokenVerifierOptions = {}): IdTokenVerifier {
  const fetcher = options.fetcher ?? (options.jwks === undefined ? new BackoffFetcher() : pinnedFetcher(options.jwks));
  const jwksCache = new SimpleJwksCache({ fetcher });
  const verifier = CognitoJwtVerifier.create({ userPoolId: config.userPoolId, clientId: config.clientId, tokenUse: "id" }, { jwksCache });
  if (options.jwks !== undefined) verifier.cacheJwks(options.jwks);

  return {
    async verify(token) {
      try {
        const payload: unknown = await verifier.verify(token);
        return IdTokenClaims.parse(payload);
      } catch (error) {
        throw toAuthError(error);
      }
    },
  };
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** Extracts the token of an `Authorization: Bearer <jwt>` header; rejects with TOKEN_MISSING. */
export function bearerToken(authorization: string | undefined): string {
  const match = authorization === undefined ? null : BEARER.exec(authorization.trim());
  const token = match?.[1];
  if (!token) throw new AuthError(AUTH_REASON.TOKEN_MISSING, "missing bearer token");
  return token;
}
