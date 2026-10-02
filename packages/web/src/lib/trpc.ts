// tRPC client of the console and of the public sign-up: same origin, `/api` behind the Router.
//
//   signup.*   one request per call (httpLink, never in a batch): the BFF refuses a batch that names a
//              `signup.*` procedure and WAF's rules look at each one (ADR-0015 §3.1). No token. A
//              `202` + `x-amzn-waf-action: challenge` or WAF's HTML 403 become the errors of lib/waf.ts.
//   the rest   batched (httpBatchLink), the id token in `X-Legajo-Auth: Bearer <idToken>`: CloudFront
//              signs the origin request with SigV4 and replaces `Authorization` (OAC, ADR-0015 §3.1).
//
// Every POST carries `x-amz-content-sha256` with the SHA-256 of its body (lib/body-hash.ts). A refusal
// the whole console reacts to (a guest world that is gone, a usage quota) is reported once to
// `onRefusal`, whatever view made the call; the view still gets its own error.
import { createTRPCClient, httpBatchLink, httpLink, splitLink, type TRPCClient } from "@trpc/client";
import { withBodyHash } from "./body-hash";
import { API_URL } from "./env";
import { fetchWithRetry } from "./http";
import type { AppRouter } from "./trpc-router";
import { assertNotWaf } from "./waf";

export type ConsoleClient = TRPCClient<AppRouter>;

/** Header of the id token behind the Router (never `Authorization`, which CloudFront replaces). */
export const AUTH_HEADER = "x-legajo-auth";

const REQUEST_TIMEOUT_MS = 20_000;
const SIGNUP_PREFIX = "signup.";

/** A refusal of the BFF, by its `reason`, with the rest of the error `data` (e.g. `quota`). */
export interface ConsoleRefusal {
  readonly reason: string;
  readonly path: string | undefined;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ConsoleClientOptions {
  readonly getIdToken: () => string | undefined;
  readonly onRefusal?: (refusal: ConsoleRefusal) => void;
}

export function isSignupPath(path: string): boolean {
  return path.startsWith(SIGNUP_PREFIX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The refusals in a tRPC answer: one object, or one per call of a batch. */
export function refusalsOf(body: unknown): ConsoleRefusal[] {
  const items = Array.isArray(body) ? body : [body];
  return items.flatMap((item) => {
    const error = isRecord(item) ? item.error : undefined;
    const data = isRecord(error) ? error.data : undefined;
    if (!isRecord(data) || typeof data.reason !== "string") return [];
    return [{ reason: data.reason, path: typeof data.path === "string" ? data.path : undefined, data }];
  });
}

async function report(response: Response, onRefusal: ConsoleClientOptions["onRefusal"]): Promise<void> {
  if (!onRefusal || (response.ok && response.status !== 207)) return;
  try {
    for (const refusal of refusalsOf(await response.clone().json())) onRefusal(refusal);
  } catch {
    // Not JSON: nothing the console can react to; the view shows its own error.
  }
}

function isGet(init: RequestInit | undefined): boolean {
  return (init?.method ?? "GET").toUpperCase() === "GET";
}

/** `getIdToken` alone, or with the hook for refusals (the session context passes both). */
export function createConsoleClient(input: ConsoleClientOptions | ConsoleClientOptions["getIdToken"]): ConsoleClient {
  const options: ConsoleClientOptions = typeof input === "function" ? { getIdToken: input } : input;
  const consoleFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetchWithRetry(input, await withBodyHash(input, init), { timeoutMs: REQUEST_TIMEOUT_MS });
    await report(response, options.onRefusal);
    return response;
  };
  // A sign-up POST is sent once: a replay after a timeout could start a second sign-up.
  const signupFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signed = await withBodyHash(input, init);
    return assertNotWaf(await fetchWithRetry(input, signed, { timeoutMs: REQUEST_TIMEOUT_MS, attempts: isGet(init) ? 3 : 1 }));
  };
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => isSignupPath(op.path),
        true: httpLink({ url: API_URL, fetch: signupFetch }),
        false: httpBatchLink({
          url: API_URL,
          fetch: consoleFetch,
          headers: () => {
            const token = options.getIdToken();
            return token ? { [AUTH_HEADER]: `Bearer ${token}` } : {};
          },
        }),
      }),
    ],
  });
}
