// The token set of the console session. Tokens live in sessionStorage: they die with the tab and
// never reach localStorage, where any script of the origin would outlive the session. Passwords and
// TOTP secrets are never stored anywhere: they exist only in the memory of the form that uses them.
// The id token is what the BFF expects in `X-Legajo-Auth` (principal from the id token, lib/trpc.ts).
import { z } from "zod";
import type { AuthenticationResult, CognitoApi } from "./cognito";

export const TOKENS_KEY = "legajo.console.tokens";

/** Tokens are considered expired this long before Cognito says so, to absorb clock skew. */
const EXPIRY_SKEW_MS = 30_000;

const TokenSetSchema = z.object({
  idToken: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** Epoch milliseconds. */
  expiresAt: z.number().int(),
});
export type TokenSet = z.infer<typeof TokenSetSchema>;

export function tokenSetOf(result: AuthenticationResult, now: number, previousRefreshToken?: string): TokenSet {
  // REFRESH_TOKEN_AUTH answers without a refresh token unless rotation is on: keep the one we had.
  const refreshToken = result.RefreshToken ?? previousRefreshToken;
  return {
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    expiresAt: now + result.ExpiresIn * 1000,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  };
}

// sessionStorage can throw (private mode, storage disabled); the console must still render.
export function loadTokens(): TokenSet | undefined {
  try {
    const raw = sessionStorage.getItem(TOKENS_KEY);
    if (!raw) return undefined;
    const parsed = TokenSetSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function saveTokens(tokens: TokenSet): void {
  try {
    sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  } catch {
    // Nothing to do: the session simply will not survive a reload.
  }
}

export function clearTokens(): void {
  try {
    sessionStorage.removeItem(TOKENS_KEY);
  } catch {
    // Same as above.
  }
}

export function isExpired(tokens: TokenSet, now = Date.now()): boolean {
  return tokens.expiresAt - EXPIRY_SKEW_MS <= now;
}

// One refresh per refresh token at a time: a second caller (React's double effects in development,
// the silent-refresh timer racing the page load) gets the same answer instead of a second request.
const refreshing = new Map<string, Promise<TokenSet>>();

// Bumped by every sign-out: a refresh that started before it must not write a fresh id token back
// into sessionStorage afterwards (the BFF verifies id tokens offline, so it would stay usable).
let generation = 0;

/** Thrown by a refresh whose session was signed out while it was in flight. */
export class SessionEndedError extends Error {
  override readonly name = "SessionEndedError";
}

export async function refreshTokens(cognito: Pick<CognitoApi, "refresh">, current: TokenSet, now: () => number = Date.now): Promise<TokenSet> {
  const refreshToken = current.refreshToken;
  if (!refreshToken) throw new Error("no refresh token");
  const pending = refreshing.get(refreshToken);
  if (pending) return pending;
  const started = generation;
  const request = cognito
    .refresh(refreshToken)
    .then((result) => {
      if (started !== generation) throw new SessionEndedError("the session was signed out during the refresh");
      const tokens = tokenSetOf(result, now(), refreshToken);
      saveTokens(tokens);
      return tokens;
    })
    .finally(() => refreshing.delete(refreshToken));
  refreshing.set(refreshToken, request);
  return request;
}

/** Drops every refresh in flight: whatever they answer is never saved. */
export function cancelRefreshes(): void {
  generation += 1;
  refreshing.clear();
}

/** Tokens usable right now: stored and fresh, or refreshed if a refresh token exists. */
export async function restoreSession(cognito: Pick<CognitoApi, "refresh">): Promise<TokenSet | undefined> {
  const stored = loadTokens();
  if (!stored) return undefined;
  if (!isExpired(stored)) return stored;
  if (!stored.refreshToken) {
    clearTokens();
    return undefined;
  }
  try {
    return await refreshTokens(cognito, stored);
  } catch {
    clearTokens();
    return undefined;
  }
}

/**
 * Ends the session: refreshes in flight are dropped, the local copy goes, and the refresh token (and
 * the access tokens issued from it) is revoked at Cognito. A failed revocation still signs out
 * locally; the tokens expire on their own.
 */
export async function revokeSession(cognito: Pick<CognitoApi, "revoke">, tokens: TokenSet | undefined): Promise<void> {
  cancelRefreshes();
  clearTokens();
  if (!tokens?.refreshToken) return;
  try {
    await cognito.revoke(tokens.refreshToken);
  } catch {
    // Offline or already revoked: nothing the user can do about it.
  }
}

/** Sanitizes a post-login destination: same-origin paths only, never the login route. */
export function safeReturnTo(candidate: string | null | undefined, loginPath: string, fallback = "/"): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.startsWith("/\\")) return fallback;
  if (candidate === loginPath || candidate.startsWith(`${loginPath}?`) || candidate.startsWith(`${loginPath}/`)) return fallback;
  return candidate;
}
