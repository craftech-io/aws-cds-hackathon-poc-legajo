// Single source of every number of the public sign-up and of the guest worlds (ADR-0015 §3.2 and §4):
// the BFF, the triggers, `SignupDispatch`, the janitor, the web copy and the tests import them from
// here and never repeat a value. Changing a limit is a change of this file only (ADR-0015,
// "Consequences"). Windows are fixed real-time buckets in UTC (an hour, a day, ten minutes): a counter
// is `Runtime/<prefix>#<window>` and resets when its bucket ends.
import { z } from "zod";

// ---- Sign-up (ADR-0015 §1 to §3) ----------------------------------------------------------------

/** A form sent sooner than this after `signup.form` is a bot's (honeypot and time, §3.1). */
export const SIGNUP_FORM_MIN_SECONDS = 3;
/** …and later than this too: `formToken` lives two hours. */
export const SIGNUP_FORM_MAX_SECONDS = 2 * 60 * 60;
/** Validity of the sign-up ticket `SignupDispatch` puts in `ValidationData` (§1). */
export const SIGNUP_TICKET_TTL_SECONDS = 120;
/** `Leads/SIGNUP#<signupId>` expires by DynamoDB TTL after a day (§2). */
export const SIGNUP_PENDING_TTL_SECONDS = 24 * 60 * 60;
/** Seconds between two `signup.resend` of one sign-up (`resendAfterSec`). */
export const RESEND_WAIT_SECONDS = 60;
/** `signup.resend` per sign-up. */
export const RESEND_MAX_PER_SIGNUP = 3;
/** Wrong codes per sign-up; the next one closes it (`EXPIRED`: start again). */
export const CONFIRM_MAX_ATTEMPTS = 5;
/** Every `signup.confirm` answer that is not `CONFIRMED` leaves at this many ms after the request started (§1.1). */
export const NON_CONFIRMED_RESPONSE_MS = 1_500;
/** Name, company and job title: optional, plain text, at most this long (§2). */
export const SIGNUP_OPTIONAL_MAX_CHARS = 80;
/** Each `utm_*` value kept (`[A-Za-z0-9._~ -]`); anything else is dropped (§2). */
export const UTM_VALUE_MAX_CHARS = 100;
/** Referrer reduced to scheme and host (§2). */
export const REFERRER_MAX_CHARS = 200;
/** Deadline of the MX lookup of the email's domain in `SignupDispatch` (§3.2). */
export const SIGNUP_MX_TIMEOUT_MS = 1_500;

/** A fixed bucket of real time; counters reset when their bucket ends. */
export const LimitWindow = z.enum(["TEN_MINUTES", "HOUR", "DAY"]);
export type LimitWindow = z.infer<typeof LimitWindow>;

export interface WindowedLimit {
  readonly window: LimitWindow;
  readonly limit: number;
}

/** Limits of the sign-up kept by the BFF and `SignupDispatch` in `Runtime/RL#…` (ADR-0015 §3.2). */
export const SIGNUP_RATE_LIMITS = {
  /** `signup.start` per viewer IP (`/32` or `/64`) → `RATE_LIMITED`. */
  startPerIp: [
    { window: "HOUR", limit: 5 },
    { window: "DAY", limit: 20 },
  ],
  /** `signup.start` per email → `SUPPRESSED` (same `CODE_SENT`, nothing sent). */
  startPerEmail: [{ window: "DAY", limit: 3 }],
  /** New sign-ups per email domain → `SUPPRESSED`. */
  startPerDomain: [{ window: "HOUR", limit: 30 }],
  /** New sign-ups in total → `CAPACITY`. */
  startTotal: [
    { window: "HOUR", limit: 100 },
    { window: "DAY", limit: 300 },
  ],
  /** `signup.confirm` per viewer IP → `RATE_LIMITED`. */
  confirmPerIp: [{ window: "HOUR", limit: 30 }],
} as const satisfies Readonly<Record<string, readonly WindowedLimit[]>>;
export type SignupRateLimit = keyof typeof SIGNUP_RATE_LIMITS;

/** Account emails (`AuthCustomMessage`, every trigger source); past them the trigger fails and Cognito sends nothing. */
export const ACCOUNT_EMAIL_LIMITS = {
  perRecipient: [{ window: "DAY", limit: 5 }],
  perDomain: [{ window: "HOUR", limit: 60 }],
  total: [{ window: "DAY", limit: 400 }],
} as const satisfies Readonly<Record<string, readonly WindowedLimit[]>>;
export type AccountEmailLimit = keyof typeof ACCOUNT_EMAIL_LIMITS;

/** Reputation breaker of the account's SES (ADR-0015 §3.2): opened by `ChannelEvents`, closed only by the operator. */
export const MAIL_BREAKER = {
  /** Hourly buckets summed: the last 24 hours. */
  lookbackHours: 24,
  /**
   * Complaints that open it, whatever the volume. Bounces never count here: a code to a non-existent
   * mailbox of a real domain bounces for anyone who asks, and ten of them must not stop the product.
   */
  complaintCount: 10,
  /** …or bounces plus complaints above this share of the account emails sent, once at least `minSent` went out. */
  badRate: 0.03,
  minSent: 100,
} as const;

/** `Runtime/MAILSTATUS#<emailHash>` lives this long after its last event (24 months). */
export const MAIL_STATUS_TTL_SECONDS = 730 * 24 * 60 * 60;
/** Every `Runtime/RL#…` and `QUOTA#…` counter expires this long after its window ends. */
export const COUNTER_GRACE_SECONDS = 60 * 60;

// ---- Leads (ADR-0015 §6) --------------------------------------------------------------------------

/** Destinations of `LeadNoticeTo`, comma separated. */
export const LEAD_NOTICE_MAX_RECIPIENTS = 3;
/** Attempts of a lead notice before `noticeStatus FAILED`; `GUEST_SWEEP` retries hourly. */
export const LEAD_NOTICE_MAX_ATTEMPTS = 5;
/** A lead without a sign-in for this long (or since its sign-up) is deleted by retention. */
export const LEAD_RETENTION_DAYS = 730;
/** `GUEST_SWEEP` deletes `UNCONFIRMED` Cognito users without groups older than this. */
export const UNCONFIRMED_USER_MAX_AGE_HOURS = 24;

// ---- Guest worlds (ADR-0015 §4) -------------------------------------------------------------------

/** Two-digit slots: `01–30` reserved accounts, `31–90` public, `91–99` unused. */
export const GUEST_SLOTS = {
  reserved: { first: 1, last: 30 },
  public: { first: 31, last: 90 },
} as const;
/** Reserved accounts `guest-01..NN` the operator invites by default. */
export const RESERVED_GUESTS_DEFAULT = 15;
/** A released slot is not leased again before this (id token life plus tolerance). */
export const SLOT_RELEASE_COOLDOWN_MINUTES = 20;
/** A `CREATING` lease older than this is a creation that fell over and may be taken again. */
export const GUEST_WORLD_CREATING_STALE_MINUTES = 5;
/** A public world is destroyed after this many real hours without activity… */
export const GUEST_WORLD_IDLE_HOURS = 24;
/** …or this many real hours after it was created, whichever comes first. */
export const GUEST_WORLD_MAX_AGE_HOURS = 72;
/** A reserved world idle for this long is reset at night (`IDLE_GUEST_RESET`). */
export const RESERVED_WORLD_IDLE_RESET_HOURS = 24;
/** Largest PDF a guest world accepts (simulator and upload links). */
export const GUEST_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** "Reloj en vivo" runs this long each time. */
export const LIVE_CLOCK_MINUTES = 30;

/** What a guest world counts in real time (ADR-0015 §4); the console labels each one. */
export const QuotaKind = z.enum([
  "AGENT_TURNS",
  "OUTBOUND_EMAILS",
  "SIMULATOR_MESSAGES",
  "CLOCK_MOVES",
  "PDF_UPLOADS",
  "NEW_OPERATIONS",
  "WORLD_RESETS",
  "LIVE_CLOCK",
  "WORLD_PREPARATIONS",
]);
export type QuotaKind = z.infer<typeof QuotaKind>;

/** `kind` of a `QUOTA_EXCEEDED`: a world's own quota, or the global budget of the public worlds. */
export const QuotaExceededKind = z.enum([...QuotaKind.options, "GLOBAL"]);
export type QuotaExceededKind = z.infer<typeof QuotaExceededKind>;

/** Quotas of every guest world, reserved and public alike. */
export const GUEST_QUOTAS: Readonly<Record<QuotaKind, readonly WindowedLimit[]>> = {
  AGENT_TURNS: [
    { window: "HOUR", limit: 30 },
    { window: "DAY", limit: 120 },
  ],
  OUTBOUND_EMAILS: [
    { window: "HOUR", limit: 60 },
    { window: "DAY", limit: 200 },
  ],
  SIMULATOR_MESSAGES: [
    { window: "HOUR", limit: 30 },
    { window: "DAY", limit: 150 },
  ],
  CLOCK_MOVES: [{ window: "DAY", limit: 300 }],
  PDF_UPLOADS: [{ window: "DAY", limit: 40 }],
  NEW_OPERATIONS: [{ window: "DAY", limit: 10 }],
  WORLD_RESETS: [
    { window: "TEN_MINUTES", limit: 1 },
    { window: "DAY", limit: 12 },
  ],
  LIVE_CLOCK: [{ window: "DAY", limit: 6 }],
  /** Counted per account (`sub`), not per world: `account.ensureWorld` calls. */
  WORLD_PREPARATIONS: [{ window: "HOUR", limit: 10 }],
};

/** Kinds the global budget of the public worlds also counts, per UTC day (until 00:00 UTC). */
export const PUBLIC_GLOBAL_BUDGET: Readonly<Partial<Record<QuotaKind, number>>> = {
  AGENT_TURNS: 1_500,
  OUTBOUND_EMAILS: 1_500,
};

const WINDOW_MS: Readonly<Record<LimitWindow, number>> = { TEN_MINUTES: 10 * 60_000, HOUR: 60 * 60_000, DAY: 24 * 60 * 60_000 };

export function windowMs(window: LimitWindow): number {
  return WINDOW_MS[window];
}

/** The bucket of `at`: `2026-10-14T13:20Z` (ten minutes), `2026-10-14T13` (hour), `2026-10-14` (day), all UTC. */
export function windowBucket(window: LimitWindow, at: Date): string {
  const iso = at.toISOString();
  if (window === "DAY") return iso.slice(0, 10);
  if (window === "HOUR") return iso.slice(0, 13);
  const minute = Math.floor(at.getUTCMinutes() / 10) * 10;
  return `${iso.slice(0, 14)}${String(minute).padStart(2, "0")}Z`;
}

/** First instant of the next bucket: when a counter of `at`'s bucket resets. */
export function windowEnd(window: LimitWindow, at: Date): Date {
  const size = WINDOW_MS[window];
  return new Date(Math.floor(at.getTime() / size) * size + size);
}
