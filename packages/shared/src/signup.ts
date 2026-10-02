// Contract of the public sign-up and of a guest's bootstrap (ADR-0015 §1, §2 and §4; docs/tool-catalog.md
// "Alta pública e invitados"): inputs, outputs and refusal reasons of `signup.*`, the world states of
// `account.world` / `account.ensureWorld` and the shape of `account.usage`. The BFF validates every
// request with these schemas and the sign-up form runs the same ones in the browser, so a form error
// is told the same way on both sides. One sign-up flow, no modes and no waitlist (ADR-0015 §1.4).
import { z } from "zod";
import { CalendarDate } from "./dates";
import { Language } from "./enums";
import { LimitWindow, QuotaExceededKind, QuotaKind, REFERRER_MAX_CHARS, SIGNUP_OPTIONAL_MAX_CHARS, UTM_VALUE_MAX_CHARS } from "./guest-limits";
import { LegalVersions } from "./legal-versions";
import { Password } from "./password-policy";

/** RFC 5321 caps an address at 254 characters; trimmed and lower-cased before anything else. */
export const SIGNUP_EMAIL_MAX_CHARS = 254;

/** Same normalization as `normalizeEmail` of hash.ts, as a schema that refuses instead of throwing. */
export const SignupEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(SIGNUP_EMAIL_MAX_CHARS)
  .pipe(z.email());
export type SignupEmail = z.infer<typeof SignupEmail>;

// Plain text only: no control characters; rendering escapes the rest.
const PlainText = z
  .string()
  .trim()
  .max(SIGNUP_OPTIONAL_MAX_CHARS)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "plain text only");

/** Optional free field: an empty one is the same as an absent one. */
const OptionalText = PlainText.optional().transform((value) => (value === undefined || value === "" ? undefined : value));

/** `AAAA-MM-DD` of a text version (`LEGAL_VERSIONS`, packages/shared/src/legal-versions.ts). */
export const LegalVersion = CalendarDate;

/** The versions the form was shown with; `signup.start` refuses any other than `LEGAL_VERSIONS`. */
export const ConsentVersions = LegalVersions;
export type ConsentVersions = LegalVersions;

/** Both boxes start unticked; `terms` must be ticked to create the account, `contact` is free. */
export const SignupConsents = z.object({ terms: z.literal(true), contact: z.boolean() }).strict();

// Attribution arrives as the browser read it; the BFF keeps only what passes `sanitizeUtm` and
// `sanitizeReferrer`, so a bad value is dropped, never an `INVALID` (ADR-0015 §2).
const RawAttribution = z.string().max(2_048);

export const SignupUtmInput = z
  .object({ source: RawAttribution.optional(), medium: RawAttribution.optional(), campaign: RawAttribution.optional(), term: RawAttribution.optional(), content: RawAttribution.optional() })
  .strict();

/** Opaque, signed by the BFF; carries when the form was shown (`signup.form`). */
export const FormToken = z.string().min(16).max(512);

export const SignupFormInput = z.object({ lang: Language }).strict();
export const SignupFormOutput = z.object({ formToken: FormToken });
export type SignupFormOutput = z.infer<typeof SignupFormOutput>;

export const SignupStartInput = z
  .object({
    formToken: FormToken,
    email: SignupEmail,
    password: Password,
    name: OptionalText,
    company: OptionalText,
    jobTitle: OptionalText,
    consents: SignupConsents,
    consentVersions: ConsentVersions,
    lang: Language,
    utm: SignupUtmInput.optional(),
    referrer: RawAttribution.optional(),
    /** Honeypot: a person never fills it. Any value is accepted here and suppressed later, silently. */
    website: z.string().max(2_048),
  })
  .strict();
export type SignupStartInput = z.input<typeof SignupStartInput>;
export type SignupStartRequest = z.output<typeof SignupStartInput>;

/** 26 random characters of Crockford base32, `Leads/SIGNUP#<signupId>`. */
export const SignupId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "expected a sign-up id");
export type SignupId = z.infer<typeof SignupId>;

export const CodeSent = z.object({ status: z.literal("CODE_SENT"), signupId: SignupId, resendAfterSec: z.number().int().min(0) });
export const RateLimited = z.object({ status: z.literal("RATE_LIMITED"), retryAfterSec: z.number().int().min(1) });
export const Capacity = z.object({ status: z.literal("CAPACITY") });
export const Expired = z.object({ status: z.literal("EXPIRED") });

/** `CODE_SENT` in every branch (the dispatch decides after answering), or a limit that says nothing about the email. */
export const SignupStartOutput = z.discriminatedUnion("status", [CodeSent, RateLimited, Capacity]);
export type SignupStartOutput = z.infer<typeof SignupStartOutput>;

export const SignupResendInput = z.object({ signupId: SignupId }).strict();
export const SignupResendOutput = z.discriminatedUnion("status", [CodeSent.omit({ signupId: true }), RateLimited, Capacity, Expired]);
export type SignupResendOutput = z.infer<typeof SignupResendOutput>;

/** The code Cognito mailed: six digits. */
export const SignupCode = z.string().regex(/^[0-9]{6}$/, "expected six digits");

export const SignupConfirmInput = z.object({ signupId: SignupId, code: SignupCode, password: Password }).strict();
export const SignupConfirmOutput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("CONFIRMED") }),
  z.object({ status: z.literal("CODE_INVALID"), attemptsLeft: z.number().int().min(0) }),
  Expired,
  RateLimited,
]);
export type SignupConfirmOutput = z.infer<typeof SignupConfirmOutput>;

/**
 * `reason` of a refused `signup.*` (tRPC `BAD_REQUEST`): only form errors, never a word about the
 * email. `CONSENT_VERSIONS_OUTDATED`: the page shows old texts and must be reloaded (FL-119 d).
 */
export const SignupInvalidReason = z.enum(["INVALID", "CONSENT_VERSIONS_OUTDATED", "NO_VIEWER_IP", "BATCH_NOT_ALLOWED"]);
export type SignupInvalidReason = z.infer<typeof SignupInvalidReason>;

/** What `SignupDispatch` decided for a sign-up (ADR-0015 §1.2); `FAILED`: the dispatch broke and a resend may retry. */
export const SignupBranch = z.enum(["NEW", "EXISTING_GUEST", "INELIGIBLE", "SUPPRESSED", "FAILED"]);
export type SignupBranch = z.infer<typeof SignupBranch>;

/** Why a sign-up was refused or suppressed (`LegajoAgent/SignupRejected {reason}`); never names the email. */
export const SignupRejectReason = z.enum([
  "HONEYPOT",
  "TOO_FAST",
  "TOO_SLOW",
  "FORM_TOKEN",
  "RESERVED_DOMAIN",
  "OWN_DOMAIN",
  "NO_MX",
  "EMAIL_QUOTA",
  "DOMAIN_QUOTA",
  "MAIL_STATUS",
  "BREAKER_OPEN",
  "INELIGIBLE",
  "IP_RATE",
  "TOTAL_CAPACITY",
  "NO_VIEWER_IP",
  "CONFIRM_IP_RATE",
]);
export type SignupRejectReason = z.infer<typeof SignupRejectReason>;

// ---- Guest bootstrap: account.world, account.ensureWorld, account.usage ------------------------------

/** States of a guest's world (ADR-0015 §4); quotas are not a state, they are `QUOTA_EXCEEDED`. */
export const GuestWorldState = z.enum(["NONE", "CREATING", "READY", "EXPIRED", "CAPACITY", "FAILED"]);
export type GuestWorldState = z.infer<typeof GuestWorldState>;

export const AccountWorldOutput = z.object({
  state: GuestWorldState,
  firmId: z.string().optional(),
  clockId: z.string().optional(),
  since: z.string().optional(),
});
export type AccountWorldOutput = z.infer<typeof AccountWorldOutput>;

export const EnsureWorldOutput = z.discriminatedUnion("state", [
  z.object({ state: z.literal("CREATING") }),
  z.object({ state: z.literal("READY"), firmId: z.string(), clockId: z.string() }),
  z.object({ state: z.literal("CAPACITY") }),
]);
export type EnsureWorldOutput = z.infer<typeof EnsureWorldOutput>;

export const QuotaUsage = z.object({ kind: QuotaKind, window: LimitWindow, used: z.number().int().min(0), limit: z.number().int().min(1), resetsAtReal: z.string() });
export type QuotaUsage = z.infer<typeof QuotaUsage>;

export const AccountUsageOutput = z.object({ quotas: z.array(QuotaUsage), globalBudget: z.enum(["OK", "EXHAUSTED"]) });
export type AccountUsageOutput = z.infer<typeof AccountUsageOutput>;

/** `data.quota` of a `QUOTA_EXCEEDED` refusal (tRPC `TOO_MANY_REQUESTS`, `reason: "QUOTA_EXCEEDED"`). */
export const QuotaExceededData = z.object({ kind: QuotaExceededKind, resetsAtReal: z.string() });
export type QuotaExceededData = z.infer<typeof QuotaExceededData>;

// ---- Attribution ------------------------------------------------------------------------------------

const UTM_VALUE = new RegExp(`^[A-Za-z0-9._~ -]{1,${UTM_VALUE_MAX_CHARS}}$`);
const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;
export type SignupUtm = Partial<Record<(typeof UTM_KEYS)[number], string>>;

/** Keeps each `utm_*` value made only of `[A-Za-z0-9._~ -]` and at most 100 characters (ADR-0015 §2). */
export function sanitizeUtm(utm: z.infer<typeof SignupUtmInput> | undefined): SignupUtm {
  const out: SignupUtm = {};
  for (const key of UTM_KEYS) {
    const value = utm?.[key]?.trim();
    if (value !== undefined && UTM_VALUE.test(value)) out[key] = value;
  }
  return out;
}

/** Scheme and host of the referrer, at most 200 characters; dropped when it is the app's own origin. */
export function sanitizeReferrer(referrer: string | undefined, ownOrigin: string): string | undefined {
  if (referrer === undefined || referrer === "") return undefined;
  const url = (() => {
    try {
      return new URL(referrer);
    } catch {
      return undefined;
    }
  })();
  if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) return undefined;
  const origin = `${url.protocol}//${url.host}`.toLowerCase();
  if (origin === ownOrigin.toLowerCase() || origin.length > REFERRER_MAX_CHARS) return undefined;
  return origin;
}
