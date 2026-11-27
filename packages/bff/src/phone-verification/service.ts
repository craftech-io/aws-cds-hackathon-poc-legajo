// The SMS code of every sign-in session (ADR-0021; docs/tool-catalog.md "Verificación del celular"),
// without tRPC: routers/phone.ts calls it with the account and the session of the verified id token.
//
//   status   CLEARED (this session passed) | ENROL (no verified number yet; the form's number to
//            prefill) | SIGN_IN (the verified number, by its last four digits)
//   send     ENROL: the typed or the form's number, refused when it is not a person's mobile, filler or
//            outside the Americas (phone-policy.ts) or when another account verified it; SIGN_IN:
//            always the verified number, any number sent is refused (`PHONE_LOCKED`). Then a minute since
//            the last code, the SMS limits, the code's HMAC stored over the previous code (conditional),
//            the SMS; a failed SMS removes the code
//   verify   the code of this session, alive, with tries left; a wrong one counts conditionally and the
//            fifth closes it. A right one (constant-time comparison): ENROL binds the number to the account
//            (one account per number) and turns the lead draft into the lead and its notice; both mark this
//            session as cleared and remove the code
//   end      sign-out: the session's mark goes away
import { randomInt } from "node:crypto";
import { type Language } from "@legajo/shared";
import { PHONE_CODE } from "@legajo/shared/guest-limits";
import { type PhoneRefusal, isAmericasNumber, isHomeNumber, phoneRefusal } from "@legajo/shared/phone-policy";
import { type PhoneStatusOutput, type SendPhoneCodeOutput, type VerifyPhoneCodeOutput, phoneHint } from "@legajo/shared/phone-verification";
import { countMetric } from "../channels/adapter";
import { type SecretKey, hmacSha256Hex, safeEqual } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { AccessDeps } from "../signup/deps";
import { consumeSms } from "./caps";
import { enrolLead } from "./enrol";
import type { PhoneCodeRecord } from "./records";
import { smsText } from "./sms";

export type PhoneDeps = Pick<AccessDeps, "client" | "phones" | "leads" | "invoker" | "sms" | "keys" | "now" | "newUlid" | "newPhoneCode">;

/** Who asks, all of it from the verified id token (and the viewer's IP of CloudFront). */
export interface PhoneAccount {
  readonly sub: string;
  readonly sessionId: string;
  /** Cognito username: the key of the sign-up's lead draft. */
  readonly username: string;
  readonly email?: string;
  readonly ipHash?: string;
  /** The account's language (its preference, else the sign-up's): the SMS is written in it. */
  readonly lang: Language;
}

export const PHONE_METRICS = { sent: "PhoneCodeSent", refused: "PhoneCodeRefused", cleared: "PhoneSessionCleared", failed: "PhoneCodeSendFailed" } as const;

/** Six digits from the system's CSPRNG. */
export function newPhoneCode(): string {
  return String(randomInt(0, 10 ** PHONE_CODE.digits)).padStart(PHONE_CODE.digits, "0");
}

export function accountPhoneHash(key: SecretKey, phone: string): string {
  return hmacSha256Hex(key, `phone|${phone}`);
}

/** The code is bound to the account, the session and the number it went to: replaying it elsewhere fails. */
export function codeHash(key: SecretKey, code: Pick<PhoneCodeRecord, "sub" | "sessionId" | "phoneHash">, digits: string): string {
  return hmacSha256Hex(key, `code|${code.sub}|${code.sessionId}|${code.phoneHash}|${digits}`);
}

const epoch = (date: Date): number => Math.floor(date.getTime() / 1000);

/**
 * What this sign-in session may do, from the account's phone item: BLOCKED (the operator's block wins
 * over everything, the automation mark included), CLEARED (an automation account, or a session that
 * passed the code) or REQUIRED.
 */
export type SessionState = "CLEARED" | "REQUIRED" | "BLOCKED";

export async function sessionState(deps: Pick<PhoneDeps, "phones" | "now">, sub: string, sessionId: string): Promise<SessionState> {
  const account = await deps.phones.getAccount(sub);
  if (account?.blockedAt !== undefined) return "BLOCKED";
  if (account?.automation !== undefined) return "CLEARED";
  return (await deps.phones.isSessionCleared(sub, sessionId, deps.now())) ? "CLEARED" : "REQUIRED";
}

/** Whether this sign-in session may use the console; never for a blocked account. */
export async function isSessionCleared(deps: Pick<PhoneDeps, "phones" | "now">, sub: string, sessionId: string): Promise<boolean> {
  return (await sessionState(deps, sub, sessionId)) === "CLEARED";
}

export async function phoneStatus(deps: PhoneDeps, account: PhoneAccount): Promise<PhoneStatusOutput> {
  if (await isSessionCleared(deps, account.sub, account.sessionId)) return { status: "CLEARED" };
  const record = await deps.phones.getAccount(account.sub);
  if (record?.verifiedAt !== undefined && record.phone !== undefined) return { status: "SIGN_IN", hint: phoneHint(record.phone) };
  const draft = await deps.leads.getDraft(account.username, deps.now());
  return draft?.phone === undefined ? { status: "ENROL" } : { status: "ENROL", phone: draft.phone };
}

const REFUSAL_STATUS = { NOT_PERSONAL: "PHONE_NOT_PERSONAL", FILLER: "PHONE_INVALID", COUNTRY_NOT_ALLOWED: "PHONE_COUNTRY_NOT_ALLOWED" } as const satisfies Record<PhoneRefusal, SendPhoneCodeOutput["status"]>;

type Target = { readonly ok: true; readonly phone: string; readonly purpose: PhoneCodeRecord["purpose"] } | { readonly ok: false; readonly answer: SendPhoneCodeOutput };

async function targetOf(deps: PhoneDeps, account: PhoneAccount, typed: string | undefined): Promise<Target> {
  const record = await deps.phones.getAccount(account.sub);
  if (record?.verifiedAt !== undefined && record.phone !== undefined) {
    // Whoever holds the password must not move the code to another phone (ADR-0021 §11).
    if (typed !== undefined) return { ok: false, answer: { status: "PHONE_LOCKED" } };
    // A number verified before only the Americas were accepted never gets a code: the operator changes it.
    if (!isAmericasNumber(record.phone)) return { ok: false, answer: { status: "PHONE_COUNTRY_NOT_ALLOWED" } };
    return { ok: true, phone: record.phone, purpose: "SIGN_IN" };
  }
  const phone = typed ?? (await deps.leads.getDraft(account.username, deps.now()))?.phone;
  if (phone === undefined) return { ok: false, answer: { status: "PHONE_REQUIRED" } };
  const refusal = phoneRefusal(phone);
  if (refusal !== undefined) return { ok: false, answer: { status: REFUSAL_STATUS[refusal] } };
  const owner = await deps.phones.ownerOf(accountPhoneHash(deps.keys.accountPhone, phone));
  if (owner !== undefined && owner !== account.sub) return { ok: false, answer: { status: "PHONE_IN_USE" } };
  return { ok: true, phone, purpose: "ENROL" };
}

function refused(log: Logger, answer: SendPhoneCodeOutput): SendPhoneCodeOutput {
  countMetric(log, PHONE_METRICS.refused, { status: answer.status, ...(answer.status === "RATE_LIMITED" ? { limit: answer.limit } : {}) });
  return answer;
}

export async function sendPhoneCode(deps: PhoneDeps, account: PhoneAccount, typed: string | undefined, log: Logger): Promise<SendPhoneCodeOutput> {
  if (await isSessionCleared(deps, account.sub, account.sessionId)) return { status: "CLEARED" };
  const target = await targetOf(deps, account, typed);
  if (!target.ok) return refused(log, target.answer);
  const now = deps.now();
  const previous = await deps.phones.getCode(account.sub, now);
  if (previous !== undefined) {
    const wait = Math.ceil((Date.parse(previous.sentAt) + PHONE_CODE.resendWaitSeconds * 1000 - now.getTime()) / 1000);
    if (wait > 0) return refused(log, { status: "RATE_LIMITED", limit: "RESEND", retryAfterSec: wait });
  }
  const phoneHash = accountPhoneHash(deps.keys.accountPhone, target.phone);
  const cap = await consumeSms(deps.client, { sub: account.sub, phoneHash, home: isHomeNumber(target.phone), ...(account.ipHash === undefined ? {} : { ipHash: account.ipHash }) }, now);
  if (!cap.ok) return refused(log, { status: "RATE_LIMITED", limit: cap.limit, retryAfterSec: cap.retryAfterSec });
  const digits = deps.newPhoneCode();
  const bound = { sub: account.sub, sessionId: account.sessionId, phoneHash };
  const stored = await deps.phones.putCode(
    { ...bound, purpose: target.purpose, phone: target.phone, codeHash: codeHash(deps.keys.phoneCode, bound, digits), sentAt: now.toISOString(), codeExpiresAt: epoch(now) + PHONE_CODE.ttlSeconds, expiresAt: epoch(now) + PHONE_CODE.ttlSeconds },
    previous,
    now,
  );
  // Another tab sent a code at the same moment: that one counts.
  if (!stored) return refused(log, { status: "RATE_LIMITED", limit: "RESEND", retryAfterSec: PHONE_CODE.resendWaitSeconds });
  if ((await deps.sms.send(target.phone, smsText(digits, account.lang))) === "FAILED") {
    await deps.phones.deleteCode(account.sub);
    countMetric(log, PHONE_METRICS.failed, { purpose: target.purpose });
    return { status: "SEND_FAILED" };
  }
  countMetric(log, PHONE_METRICS.sent, { purpose: target.purpose });
  return { status: "CODE_SENT", hint: phoneHint(target.phone), resendAfterSec: PHONE_CODE.resendWaitSeconds };
}

async function wrongTry(deps: PhoneDeps, sub: string): Promise<VerifyPhoneCodeOutput> {
  const attempts = await deps.phones.countWrongTry(sub, PHONE_CODE.maxAttempts, deps.now());
  if (attempts === undefined || attempts >= PHONE_CODE.maxAttempts) {
    await deps.phones.deleteCode(sub);
    return { status: "EXPIRED" };
  }
  return { status: "CODE_INVALID", attemptsLeft: PHONE_CODE.maxAttempts - attempts };
}

export async function verifyPhoneCode(deps: PhoneDeps, account: PhoneAccount, digits: string, log: Logger): Promise<VerifyPhoneCodeOutput> {
  if (await isSessionCleared(deps, account.sub, account.sessionId)) return { status: "CLEARED" };
  const code = await deps.phones.getCode(account.sub, deps.now());
  if (code === undefined || code.sessionId !== account.sessionId || code.attempts >= PHONE_CODE.maxAttempts) return { status: "EXPIRED" };
  if (!safeEqual(codeHash(deps.keys.phoneCode, code, digits), code.codeHash)) return wrongTry(deps, account.sub);
  const now = deps.now();
  if (code.purpose === "ENROL") {
    if (!(await deps.phones.claimNumber(code.phoneHash, account.sub, now))) {
      await deps.phones.deleteCode(account.sub);
      return { status: "PHONE_IN_USE" };
    }
    await deps.phones.setVerified(account.sub, code.phone, code.phoneHash, now);
    await enrolLead(deps, account, code.phone, log);
  }
  await deps.phones.markSession(account.sub, account.sessionId, now);
  await deps.phones.deleteCode(account.sub);
  countMetric(log, PHONE_METRICS.cleared, { purpose: code.purpose });
  return { status: "CLEARED" };
}

export async function endPhoneSession(deps: Pick<PhoneDeps, "phones">, account: Pick<PhoneAccount, "sub" | "sessionId">): Promise<void> {
  await deps.phones.endSession(account.sub, account.sessionId);
}
