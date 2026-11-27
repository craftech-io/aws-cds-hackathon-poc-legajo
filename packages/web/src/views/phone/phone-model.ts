// Rules of `/verify-phone` without React (ADR-0021): where the screen goes once the session passed the
// code, what each answer of the BFF shows, and when another code may be asked for. The shapes are the
// shared contract's (packages/shared/src/phone-verification.ts).
import { AccountPhone, PhoneCode, type SendPhoneCodeOutput, type SmsLimitName, type VerifyPhoneCodeOutput } from "@legajo/shared/phone-verification";
import { CONSOLE_HOME, PHONE_PATH } from "../../routes";

/** Only a path of this app, never another origin nor the phone screen itself. */
export function returnTarget(search: URLSearchParams): string {
  const asked = search.get("returnTo");
  if (asked === null || !asked.startsWith("/") || asked.startsWith("//") || asked.startsWith(PHONE_PATH)) return CONSOLE_HOME;
  return asked;
}

export type PhoneNotice =
  | { readonly kind: "sent"; readonly hint: string }
  | { readonly kind: "limit"; readonly limit: SmsLimitName; readonly minutes: number }
  | { readonly kind: "inUse" }
  | { readonly kind: "locked" }
  | { readonly kind: "sendFailed" }
  | { readonly kind: "invalid"; readonly attemptsLeft: number }
  | { readonly kind: "expired" }
  | { readonly kind: "phoneRequired" }
  | { readonly kind: "generic" };

/** Whole minutes, at least one. */
export function minutesOf(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

export type SendOutcome = { readonly kind: "cleared" } | { readonly kind: "sent"; readonly hint: string; readonly resendAt: number } | { readonly kind: "notice"; readonly notice: PhoneNotice; readonly resendAt?: number };

export function sendOutcome(answer: SendPhoneCodeOutput, now: number): SendOutcome {
  switch (answer.status) {
    case "CLEARED":
      return { kind: "cleared" };
    case "CODE_SENT":
      return { kind: "sent", hint: answer.hint, resendAt: now + answer.resendAfterSec * 1000 };
    case "RATE_LIMITED":
      return { kind: "notice", notice: { kind: "limit", limit: answer.limit, minutes: minutesOf(answer.retryAfterSec) }, ...(answer.limit === "RESEND" ? { resendAt: now + answer.retryAfterSec * 1000 } : {}) };
    case "PHONE_IN_USE":
      return { kind: "notice", notice: { kind: "inUse" } };
    case "PHONE_LOCKED":
      return { kind: "notice", notice: { kind: "locked" } };
    case "PHONE_REQUIRED":
      return { kind: "notice", notice: { kind: "phoneRequired" } };
    case "SEND_FAILED":
      return { kind: "notice", notice: { kind: "sendFailed" } };
  }
}

export function verifyOutcome(answer: VerifyPhoneCodeOutput): { readonly kind: "cleared" } | { readonly kind: "notice"; readonly notice: PhoneNotice } {
  switch (answer.status) {
    case "CLEARED":
      return { kind: "cleared" };
    case "CODE_INVALID":
      return { kind: "notice", notice: { kind: "invalid", attemptsLeft: answer.attemptsLeft } };
    case "EXPIRED":
      return { kind: "notice", notice: { kind: "expired" } };
    case "PHONE_IN_USE":
      return { kind: "notice", notice: { kind: "inUse" } };
  }
}

/** Seconds until another code may be asked for; 0 when it may now. */
export function secondsUntil(resendAt: number | undefined, now: number): number {
  return resendAt === undefined ? 0 : Math.max(0, Math.ceil((resendAt - now) / 1000));
}

export const isValidPhone = (value: string): boolean => AccountPhone.safeParse(value).success;
export const isValidCode = (value: string): boolean => PhoneCode.safeParse(value).success;

/** Whether a notice offers Craftech's contact (the limits of the day, a number that cannot be used). */
export function offersContact(notice: PhoneNotice | undefined): boolean {
  return notice !== undefined && (notice.kind === "inUse" || notice.kind === "locked" || notice.kind === "sendFailed" || (notice.kind === "limit" && notice.limit !== "RESEND"));
}
