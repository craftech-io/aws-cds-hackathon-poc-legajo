// Items of the SMS code that guards every sign-in session (ADR-0021), in `Leads` next to the leads
// because a phone number is personal data of the same kind (ADR-0015 §6):
//
//   PHONE#<sub>        / ACCOUNT            the account's verified number (E.164, its hash, when), or the
//                                           server-side mark of an automation account (`automation`)
//   PHONE#<sub>        / CODE               the code in flight: only its HMAC, the number it went to, the
//                                           sign-in session it belongs to, tries and expiry (TTL 10 min)
//   PHONE#<sub>        / SESSION#<session>  this sign-in session passed the code (TTL: the session's life)
//   PHONENUM#<hash>    / OWNER              the account a verified number belongs to: one number, one account
//
// `<session>` is the id token's `origin_jti` (the same across refreshes of one sign-in), else
// `auth-<auth_time>`. Every write that decides something is conditional (create-only, version or ceiling).
import { z } from "zod";
import type { Key } from "../connector/index";

const Instant = z.string().min(20).max(40);
const Sub = z.string().min(1).max(128);
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** Why an account never passes the code: an automation no person drives (ADR-0021 §8). */
export const AutomationReason = z.enum(["SCENARIO_RUNNER", "QA_SIGNUP"]);
export type AutomationReason = z.infer<typeof AutomationReason>;

export const AccountPhoneRecord = z.object({
  sub: Sub,
  phone: z.string().max(16).optional(),
  phoneHash: Hex64.optional(),
  verifiedAt: Instant.optional(),
  /** Written only by the operator's scripts or the fenced QaDriver, never by a procedure a person calls. */
  automation: AutomationReason.optional(),
  version: z.number().int().min(1),
});
export type AccountPhoneRecord = z.output<typeof AccountPhoneRecord>;

export const CodePurpose = z.enum(["ENROL", "SIGN_IN"]);
export type CodePurpose = z.infer<typeof CodePurpose>;

export const PhoneCodeRecord = z.object({
  sub: Sub,
  purpose: CodePurpose,
  sessionId: z.string().min(1).max(160),
  codeHash: Hex64,
  phone: z.string().max(16),
  phoneHash: Hex64,
  attempts: z.number().int().min(0),
  sentAt: Instant,
  /** Epoch seconds: compared on every read; DynamoDB's TTL deletes it later. */
  codeExpiresAt: z.number().int(),
  expiresAt: z.number().int(),
  version: z.number().int().min(1),
});
export type PhoneCodeRecord = z.output<typeof PhoneCodeRecord>;

export const PhoneSessionRecord = z.object({ sub: Sub, sessionId: z.string().min(1).max(160), verifiedAt: Instant, expiresAt: z.number().int() });
export type PhoneSessionRecord = z.output<typeof PhoneSessionRecord>;

export const PhoneOwnerRecord = z.object({ sub: Sub, at: Instant });

export function accountPhoneKey(sub: string): Key {
  return { PK: `PHONE#${sub}`, SK: "ACCOUNT" };
}

export function phoneCodeKey(sub: string): Key {
  return { PK: `PHONE#${sub}`, SK: "CODE" };
}

export function phoneSessionKey(sub: string, sessionId: string): Key {
  return { PK: `PHONE#${sub}`, SK: `SESSION#${sessionId}` };
}

export function phoneOwnerKey(phoneHash: string): Key {
  return { PK: `PHONENUM#${phoneHash}`, SK: "OWNER" };
}

/** The sign-in session of an id token: `origin_jti`, else the instant of the sign-in. */
export function signInSessionId(token: { readonly originJti?: string; readonly authTime: number }): string {
  return token.originJti ?? `auth-${token.authTime}`;
}
