// The silent AWS WAF challenge of the sign-up, without WAF's SDK (ADR-0015 §3.3). WAF challenges the
// `GET /signup` document and the browser keeps the `aws-waf-token` cookie; a `signup.*` POST whose
// token expired gets `202` with `x-amzn-waf-action: challenge` and no interstitial. Then the page keeps
// the fields that are not secret in sessionStorage, reloads `/signup?retry=1` (a full navigation, so
// WAF challenges the document again), restores them and asks only for the password. A second
// challenge after that reload means the browser cannot pass it (a content blocker): the page says so,
// with no puzzle and no CAPTCHA. A 403 from WAF's rate rule is HTML, not the BFF's JSON.

export const WAF_ACTION_HEADER = "x-amzn-waf-action";
export const SIGNUP_RETRY_PARAM = "retry";

const DRAFT_KEY = "legajo.signup.challengeDraft";
/** Never kept across the reload, whatever the caller passes. */
const SECRET_FIELD = /pass|code|token/i;

/** A `signup.*` request WAF wants to challenge again. */
export class WafChallengeError extends Error {
  override readonly name = "WafChallengeError";
}

/** WAF refused the request outright (rate rule or reputation list): HTML 403, no `retryAfterSec`. */
export class WafBlockedError extends Error {
  override readonly name = "WafBlockedError";
}

export function isWafChallenge(response: Pick<Response, "status" | "headers">): boolean {
  return response.status === 202 && response.headers.get(WAF_ACTION_HEADER)?.trim().toLowerCase() === "challenge";
}

/** A 403 that did not come from the BFF (whose refusals are always JSON). */
export function isWafBlock(response: Pick<Response, "status" | "headers">): boolean {
  if (response.status !== 403) return false;
  const type = response.headers.get("content-type") ?? "";
  return !type.toLowerCase().includes("json");
}

/** Throws the WAF error a response stands for; returns it untouched otherwise. */
export function assertNotWaf<R extends Pick<Response, "status" | "headers">>(response: R): R {
  if (isWafChallenge(response)) throw new WafChallengeError("WAF challenge");
  if (isWafBlock(response)) throw new WafBlockedError("blocked at the edge");
  return response;
}

export type WafErrorKind = "challenge" | "blocked";

/** The WAF error behind a failed call (tRPC wraps the fetch error in its own), if any. */
export function wafErrorOf(error: unknown): WafErrorKind | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof WafChallengeError) return "challenge";
    if (current instanceof WafBlockedError) return "blocked";
    current = current.cause;
  }
  return undefined;
}

export type DraftValue = string | boolean;
export type ChallengeDraft = Readonly<Record<string, DraftValue>>;

function storage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Keeps the non-secret fields of the form for the reload; anything that looks secret is dropped. */
export function saveChallengeDraft(fields: ChallengeDraft): void {
  const kept = Object.fromEntries(Object.entries(fields).filter(([name, value]) => !SECRET_FIELD.test(name) && (typeof value === "string" || typeof value === "boolean")));
  try {
    storage()?.setItem(DRAFT_KEY, JSON.stringify(kept));
  } catch {
    // Storage disabled: the person types the fields again.
  }
}

/** The kept fields, once: reading removes them. */
export function takeChallengeDraft(): ChallengeDraft | undefined {
  const store = storage();
  if (!store) return undefined;
  try {
    const raw = store.getItem(DRAFT_KEY);
    store.removeItem(DRAFT_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, DraftValue] => !SECRET_FIELD.test(entry[0]) && (typeof entry[1] === "string" || typeof entry[1] === "boolean")));
  } catch {
    return undefined;
  }
}

/** True on the page that came back from a challenge reload. */
export function isChallengeRetry(search: URLSearchParams): boolean {
  return search.get(SIGNUP_RETRY_PARAM) === "1";
}

/** `/signup?…&retry=1`: the same query (language, campaign) plus the retry mark. */
export function challengeRetryUrl(path: string, search: URLSearchParams): string {
  const next = new URLSearchParams(search);
  next.set(SIGNUP_RETRY_PARAM, "1");
  return `${path}?${next.toString()}`;
}

/** What to do with a challenge: reload once, or tell the person the browser could not pass it. */
export function challengeOutcome(search: URLSearchParams): "reload" | "failed" {
  return isChallengeRetry(search) ? "failed" : "reload";
}
