// Where a visit came from (ADR-0015 §2, FL-130): the landing reads `utm_source|medium|campaign|term|
// content` from its address and the referrer reduced to scheme and host, keeps them in sessionStorage
// and the sign-up form sends them with `signup.start`. No cookies, no analytics. A value with any
// character outside [A-Za-z0-9._~ -] or longer than 100 characters is dropped whole (never cut or
// repaired); a referrer of our own host, or longer than 200 characters, is dropped. Storage may be
// blocked (a private window): every read and write is guarded and the sign-up works without it.

export const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type Utm = Partial<Record<UtmKey, string>>;

export const UTM_VALUE_PATTERN = /^[A-Za-z0-9._~ -]{1,100}$/;
export const REFERRER_MAX = 200;
export const ATTRIBUTION_KEY = "legajo.attribution";

export interface Attribution {
  readonly utm?: Utm;
  readonly referrer?: string;
}

/** The storage the attribution lives in; `undefined` when the browser blocks it. */
export type AttributionStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function sanitizeValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return UTM_VALUE_PATTERN.test(trimmed) ? trimmed : undefined;
}

function sanitizeUtmRecord(read: (key: UtmKey) => unknown): Utm | undefined {
  const utm: Utm = {};
  for (const key of UTM_KEYS) {
    const value = sanitizeValue(read(key));
    if (value !== undefined) utm[key] = value;
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}

/** The `utm_*` parameters of an address that pass the rules, or `undefined` when none does. */
export function utmFromSearch(search: URLSearchParams): Utm | undefined {
  return sanitizeUtmRecord((key) => search.get(`utm_${key}`) ?? undefined);
}

/** `https://news.example.com` from a full referrer; nothing for our own host, a non-web scheme or an overlong origin. */
export function sanitizeReferrer(referrer: string, ownHost: string): string | undefined {
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hostname === ownHost) return undefined;
  const origin = `${url.protocol}//${url.hostname}`;
  return origin.length <= REFERRER_MAX ? origin : undefined;
}

/** A stored attribution, re-checked: what comes back from storage is never trusted as written. */
export function parseAttribution(raw: string | null): Attribution {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return {};
    const record = value as { readonly utm?: unknown; readonly referrer?: unknown };
    const utm = typeof record.utm === "object" && record.utm !== null ? sanitizeUtmRecord((key) => (record.utm as Record<string, unknown>)[key]) : undefined;
    const referrer = typeof record.referrer === "string" && record.referrer.length <= REFERRER_MAX && /^https?:\/\/[^/\s]+$/.test(record.referrer) ? record.referrer : undefined;
    return { ...(utm ? { utm } : {}), ...(referrer ? { referrer } : {}) };
  } catch {
    return {};
  }
}

function sessionStore(): AttributionStorage {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readStored(storage: AttributionStorage): Attribution {
  try {
    return parseAttribution(storage?.getItem(ATTRIBUTION_KEY) ?? null);
  } catch {
    return {};
  }
}

export interface VisitContext {
  readonly search: URLSearchParams;
  readonly referrer: string;
  /** Host of the page itself, so an internal navigation never counts as a referrer. */
  readonly host: string;
  readonly storage: AttributionStorage;
}

function currentVisit(): VisitContext {
  return { search: new URLSearchParams(window.location.search), referrer: document.referrer, host: window.location.hostname, storage: sessionStore() };
}

/**
 * Called once at start-up on any route. A load that brings campaign parameters or an outside referrer
 * replaces what was kept (the last touch wins, whole); a load that brings neither keeps it, so the
 * full page load of `/signup` from the landing does not erase where the visit came from. Returns what
 * is kept now.
 */
export function captureAttribution(visit: VisitContext = currentVisit()): Attribution {
  const kept = readStored(visit.storage);
  const utm = utmFromSearch(visit.search);
  const referrer = visit.referrer ? sanitizeReferrer(visit.referrer, visit.host) : undefined;
  if (utm === undefined && referrer === undefined) return kept;
  const next: Attribution = { ...(utm ? { utm } : {}), ...(referrer ? { referrer } : {}) };
  try {
    visit.storage?.setItem(ATTRIBUTION_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the sign-up goes on without attribution.
  }
  return next;
}

/** What the sign-up form sends in `signup.start` (`utm?`, `referrer?`); empty when nothing was kept. */
export function readAttribution(storage: AttributionStorage = sessionStore()): Attribution {
  return readStored(storage);
}
