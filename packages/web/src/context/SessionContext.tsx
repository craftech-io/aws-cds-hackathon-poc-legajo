// Session of the console: Cognito tokens, the principal decoded from the id token, the tRPC client
// that carries it, and the security prompts of the console (sign in again to approve, enrol the
// optional TOTP, change the password; the last two never for a guest). Tokens live only in
// sessionStorage (lib/auth/tokens.ts). Two refusals concern the whole console, whatever view made the
// call: a guest whose world is gone goes to `/welcome`, and a usage quota opens `QuotaNotice`
// (ADR-0015 §4). Signing out lands on the landing's "Cerraste sesión" (FL-108). React Context +
// useState only (CLAUDE.md: no state libraries).
import type { QuotaExceededData } from "@legajo/shared/signup";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type CognitoApi, createCognitoApi } from "../lib/auth/cognito";
import { type SrpClient, createSrpClient } from "../lib/auth/srp";
import { type TokenSet, clearTokens, isExpired, refreshTokens, restoreSession, saveTokens } from "../lib/auth/tokens";
import { principalFromIdToken, type Principal } from "../lib/auth-claims";
import { readAuthEnv, type AuthEnv } from "../lib/env";
import { useRouter } from "../lib/router";
import { type ConsoleRefusal, createConsoleClient, type ConsoleClient } from "../lib/trpc";
import { CONSOLE_PREFIX, WELCOME_PATH } from "../routes";
import { currentLang } from "../views/auth/lang";
import { quotaOfRefusal } from "../views/auth/quota";
import { endSession, signedOutHref } from "../views/auth/session";

export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "unconfigured"; readonly missing: readonly string[] }
  | { readonly status: "anonymous"; readonly reason?: "expired" }
  | { readonly status: "authenticated"; readonly principal: Principal; readonly tokens: TokenSet };

/**
 * `stepUp`: sign in again (BFF `LOGIN_NOT_RECENT`); `enrollTotp`: turn on the optional TOTP;
 * `changePassword`: change the account's own password. Guests only ever get `stepUp`.
 */
export type SecurityPrompt = "stepUp" | "enrollTotp" | "changePassword";

export interface AuthServices {
  readonly cognito: CognitoApi;
  readonly srp: SrpClient;
}

export interface SessionValue {
  readonly state: SessionState;
  readonly env: AuthEnv | undefined;
  /** Cognito client and SRP of this build; undefined when the build has no Cognito variables. */
  readonly auth: AuthServices | undefined;
  readonly trpc: ConsoleClient;
  readonly prompt: SecurityPrompt | undefined;
  /** The last usage quota a call ran into, until the person dismisses it (QuotaNotice). */
  readonly quota: QuotaExceededData | undefined;
  /** Stores the tokens of a finished sign-in (or step-up) and opens the session. */
  completeSignIn(tokens: TokenSet): void;
  /** New tokens now (a guest whose world became ready: the new id token names its firm); the new principal. */
  refreshSession(): Promise<Principal | undefined>;
  /** Drops refreshes in flight, clears the tokens, revokes the refresh token, goes to the landing. */
  signOut(): void;
  dismissQuota(): void;
  /** The BFF refused the token: drop it and send the user through the login with a way back. */
  expireSession(): void;
  openPrompt(prompt: SecurityPrompt): void;
  closePrompt(): void;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

/** Refresh this long before the id token expires so no request goes out with a stale one. */
const REFRESH_LEAD_MS = 60_000;

function authenticated(tokens: TokenSet): SessionState {
  return { status: "authenticated", principal: principalFromIdToken(tokens.idToken), tokens };
}

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const { navigate } = useRouter();
  const [envResult] = useState(readAuthEnv);
  const env = envResult.ok ? envResult.env : undefined;
  const auth = useMemo<AuthServices | undefined>(
    () => (env ? { cognito: createCognitoApi({ region: env.region, clientId: env.clientId }), srp: createSrpClient(env.userPoolId) } : undefined),
    [env],
  );
  const [state, setState] = useState<SessionState>(() => (envResult.ok ? { status: "loading" } : { status: "unconfigured", missing: envResult.missing }));
  const [prompt, setPrompt] = useState<SecurityPrompt | undefined>(undefined);
  const [quota, setQuota] = useState<QuotaExceededData | undefined>(undefined);

  // The client reads the token and the router through refs so it never rebuilds on refresh.
  const tokensRef = useRef<TokenSet | undefined>(undefined);
  tokensRef.current = state.status === "authenticated" ? state.tokens : undefined;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const trpc = useMemo(
    () =>
      createConsoleClient({
        getIdToken: () => tokensRef.current?.idToken,
        onRefusal: (refusal: ConsoleRefusal) => {
          if (refusal.reason === "GUEST_WORLD_GONE") navigateRef.current(WELCOME_PATH, { replace: true });
          // `/welcome` tells its own quota (world preparations); the console's notice is for the console.
          else if (refusal.reason === "QUOTA_EXCEEDED" && window.location.pathname.startsWith(CONSOLE_PREFIX)) {
            const exceeded = quotaOfRefusal(refusal.data);
            if (exceeded) setQuota(exceeded);
          }
        },
      }),
    [],
  );

  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    void restoreSession(auth.cognito).then((tokens) => {
      if (cancelled) return;
      setState(tokens ? authenticated(tokens) : { status: "anonymous" });
    });
    return () => {
      cancelled = true;
    };
  }, [auth]);

  // Silent refresh ahead of expiry; on failure the user is sent back to login.
  useEffect(() => {
    if (!auth || state.status !== "authenticated") return;
    const { tokens } = state;
    const delay = Math.max(0, tokens.expiresAt - REFRESH_LEAD_MS - Date.now());
    const timer = window.setTimeout(() => {
      if (!tokens.refreshToken) {
        if (isExpired(tokens)) {
          clearTokens();
          setState({ status: "anonymous", reason: "expired" });
        }
        return;
      }
      void refreshTokens(auth.cognito, tokens)
        .then((refreshed) => setState(authenticated(refreshed)))
        .catch(() => {
          clearTokens();
          setState({ status: "anonymous", reason: "expired" });
        });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [auth, state]);

  const completeSignIn = useCallback((tokens: TokenSet) => {
    saveTokens(tokens);
    setState(authenticated(tokens));
  }, []);

  const refreshSession = useCallback(async (): Promise<Principal | undefined> => {
    const tokens = tokensRef.current;
    if (!auth || !tokens?.refreshToken) return undefined;
    try {
      const next = authenticated(await refreshTokens(auth.cognito, { ...tokens, expiresAt: 0 }));
      setState(next);
      return next.status === "authenticated" ? next.principal : undefined;
    } catch {
      return undefined;
    }
  }, [auth]);

  const signOut = useCallback(() => {
    const tokens = tokensRef.current;
    setPrompt(undefined);
    setQuota(undefined);
    setState({ status: "anonymous" });
    void endSession(auth?.cognito, tokens);
    navigate(signedOutHref(currentLang(new URLSearchParams(window.location.search))), { replace: true });
  }, [auth, navigate]);

  const dismissQuota = useCallback(() => setQuota(undefined), []);

  const expireSession = useCallback(() => {
    clearTokens();
    setPrompt(undefined);
    setState({ status: "anonymous", reason: "expired" });
  }, []);

  const closePrompt = useCallback(() => setPrompt(undefined), []);
  const isGuest = state.status === "authenticated" && state.principal.isGuest;
  // The console hides TOTP and the password change from a guest; nothing opens them either.
  const openPrompt = useCallback((next: SecurityPrompt) => setPrompt(isGuest && next !== "stepUp" ? undefined : next), [isGuest]);

  const value = useMemo<SessionValue>(
    () => ({ state, env, auth, trpc, prompt, quota, completeSignIn, refreshSession, signOut, dismissQuota, expireSession, openPrompt, closePrompt }),
    [state, env, auth, trpc, prompt, quota, completeSignIn, refreshSession, signOut, dismissQuota, expireSession, openPrompt, closePrompt],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

/** Principal of an authenticated session; throws if used outside the guarded area of app.tsx. */
export function usePrincipal(): Principal {
  const { state } = useSession();
  if (state.status !== "authenticated") throw new Error("usePrincipal requires an authenticated session");
  return state.principal;
}
