// Items of the `Leads` table (ADR-0015 §2 and §6), separate from every table of the demo:
//
//   SIGNUP#<signupId> / PENDING   a sign-up until it is verified and finalized (DynamoDB TTL 24 h)
//   EMAIL#<emailHash> / LEAD      a lead: always a verified email with a GUEST account (§1.4)
//   DELETED#<leadId>  / TOMB      that a lead was deleted, when and why, with no personal data
//
// `emailHash` is HMAC(K_lead-email, normalized email), the same key as `Runtime/MAILSTATUS#`.
// Who touches this table is a closed list (ADR-0015 §6): Bff, SignupDispatch (only SIGNUP#),
// WorldJanitor, LeadNotice, the fenced QaDriver and the operator's scripts.
import { z } from "zod";
import { Language } from "@legajo/shared";
import { LegalVersion, SignupBranch, SignupId } from "@legajo/shared/signup";
import type { Key } from "../connector/index";
import type { TableName } from "../lib/resource";

/**
 * `Leads` (infra/storage-tables.ts with the keys of every table, `PK`/`SK` and `expiresAt`). Its
 * logical name joins `TABLE_NAMES` of lib/resource.ts once the infra declares the table; until then
 * the name is spelled here.
 */
export const LEADS_TABLE = "Leads" as TableName;
/** `sourcePoc` of every lead of this product. */
export const SOURCE_POC = "legajo-listo";

export const EmailHash = z.string().regex(/^[0-9a-f]{64}$/, "expected a hex HMAC");
export const LeadId = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "expected a ULID");
export type LeadId = z.infer<typeof LeadId>;
const Instant = z.string().min(20).max(40);
const Text80 = z.string().max(80);

/** One consent as the visitor gave it: accepted or not, when (real time), which text version, in which language. */
export const ConsentRecord = z.object({ accepted: z.boolean(), at: Instant, version: LegalVersion, lang: Language });
export type ConsentRecord = z.infer<typeof ConsentRecord>;

/** The terms box covers terms and privacy, so it also keeps the privacy policy's version. */
export const TermsConsent = ConsentRecord.extend({ privacyVersion: LegalVersion });

export const LeadConsents = z.object({ terms: TermsConsent, contact: ConsentRecord });
export type LeadConsents = z.infer<typeof LeadConsents>;

/** Later changes of a consent (a withdrawal of contact, a new sign-up of the same email). */
export const ConsentChange = ConsentRecord.extend({ consent: z.enum(["terms", "contact"]), privacyVersion: LegalVersion.optional() });
export type ConsentChange = z.infer<typeof ConsentChange>;

export const Utm = z.object({ source: z.string(), medium: z.string(), campaign: z.string(), term: z.string(), content: z.string() }).partial();

export const NoticeStatus = z.enum(["SENT", "PENDING", "FAILED", "DISABLED"]);
export type NoticeStatus = z.infer<typeof NoticeStatus>;

export const Lead = z.object({
  leadId: LeadId,
  email: z.string().min(3).max(254),
  emailHash: EmailHash,
  name: Text80.optional(),
  company: Text80.optional(),
  jobTitle: Text80.optional(),
  consents: LeadConsents,
  consentHistory: z.array(ConsentChange).default([]),
  sourcePoc: z.literal(SOURCE_POC),
  language: Language,
  utm: Utm.default({}),
  referrer: z.string().max(200).optional(),
  signupAt: Instant,
  confirmedAt: Instant,
  lastLoginAt: Instant.optional(),
  cognitoUsername: z.string().min(1).max(128),
  noticeStatus: NoticeStatus,
  noticeAttempts: z.number().int().min(0).default(0),
  version: z.number().int().min(1),
});
export type Lead = z.output<typeof Lead>;

/** A sign-up between `signup.start` and `finalizeSignup` (ADR-0015 §2). */
export const PendingSignup = z.object({
  signupId: SignupId,
  /** `usr-<ulid>`: the email is an alias and never the Cognito user name. */
  username: z.string().regex(/^usr-[0-9a-z]{26}$/),
  email: z.string().min(3).max(254),
  emailHash: EmailHash,
  name: Text80.optional(),
  company: Text80.optional(),
  jobTitle: Text80.optional(),
  consents: LeadConsents,
  language: Language,
  utm: Utm.default({}),
  referrer: z.string().max(200).optional(),
  startedAt: Instant,
  /** When `signup.form` showed the form, from the signed `formToken`; absent when the token did not verify. */
  formShownAt: Instant.optional(),
  /** The honeypot was filled (the value itself is never stored). */
  honeypot: z.boolean(),
  /** AES-256-GCM of the password until the first step of `SignupDispatch` removes it. */
  passwordSealed: z.string().optional(),
  /** Each START and RESEND raises it; a dispatch event carrying an older value does nothing. */
  dispatchSeq: z.number().int().min(1),
  /** The `dispatchSeq` whose dispatch already took its first step: a repeated event finds it and does nothing. */
  dispatchedSeq: z.number().int().min(1).optional(),
  branch: SignupBranch.optional(),
  /** The Cognito user the code belongs to: this sign-up's own `usr-…` (`NEW`) or the existing guest's (`EXISTING_GUEST`). */
  accountUsername: z.string().min(1).max(128).optional(),
  dispatchedAt: Instant.optional(),
  /** Written right after a successful `ConfirmSignUp` or `ConfirmForgotPassword`: the only proof the mailbox's owner used the code. */
  verifiedAt: Instant.optional(),
  resends: z.number().int().min(0),
  lastResendAt: Instant.optional(),
  attempts: z.number().int().min(0),
  expiresAt: z.number().int(),
  version: z.number().int().min(1),
});
export type PendingSignup = z.output<typeof PendingSignup>;

export const Tombstone = z.object({ leadId: LeadId, deletedAt: Instant, reason: z.enum(["REQUEST", "RETENTION"]) });
export type Tombstone = z.infer<typeof Tombstone>;

export function signupKey(signupId: string): Key {
  return { PK: `SIGNUP#${signupId}`, SK: "PENDING" };
}

export function leadKey(emailHash: string): Key {
  return { PK: `EMAIL#${emailHash}`, SK: "LEAD" };
}

export function tombKey(leadId: string): Key {
  return { PK: `DELETED#${leadId}`, SK: "TOMB" };
}
