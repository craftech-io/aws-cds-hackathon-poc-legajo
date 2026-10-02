// Rules of `/signup/verify` without React (docs/landing-spec.md §8.3, FL-102, FL-103): the masked
// email, when "Reenviar código" may be pressed again and when it is gone for good, and what each answer
// of `signup.resend` and `signup.confirm` does to the screen. Waits and caps come from the BFF's answer
// (`resendAfterSec`, `retryAfterSec`, `attemptsLeft`) and from guest-limits.ts, never from here.
import { CODE_DIGITS } from "./copy";

/** `juana@dominio.com.ar` → `j***@d***.com.ar`: enough to recognise it, not to read it over a shoulder. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const [first = "", ...rest] = email.slice(at + 1).split(".");
  const domain = [`${first.slice(0, 1)}***`, ...rest].join(".");
  return `${local.slice(0, 1)}***@${domain}`;
}

export type ResendState = { readonly kind: "wait"; readonly seconds: number } | { readonly kind: "ready" } | { readonly kind: "exhausted" };

/** The resend button: a countdown, available, or gone after the last resend of this sign-up. */
export function resendState(now: number, availableAt: number, resends: number, maxResends: number): ResendState {
  if (resends >= maxResends) return { kind: "exhausted" };
  const remainingMs = availableAt - now;
  return remainingMs > 0 ? { kind: "wait", seconds: Math.ceil(remainingMs / 1000) } : { kind: "ready" };
}

/** Whole minutes for a `retryAfterSec`, never zero. */
export function minutesOf(retryAfterSec: number): number {
  return Math.max(1, Math.ceil(retryAfterSec / 60));
}

/** The six digits, ready to send; undefined while incomplete. */
export function completeCode(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, "");
  return digits.length === CODE_DIGITS ? digits : undefined;
}

export type ConfirmAnswer =
  | { readonly status: "CONFIRMED" }
  | { readonly status: "CODE_INVALID"; readonly attemptsLeft: number }
  | { readonly status: "EXPIRED" }
  | { readonly status: "RATE_LIMITED"; readonly retryAfterSec: number };

export type ConfirmOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "invalid"; readonly attemptsLeft: number; readonly showAttempts: boolean }
  | { readonly kind: "expired" }
  | { readonly kind: "rateLimited"; readonly minutes: number };

/** With this many attempts left or fewer, the screen says how many remain. */
export const ATTEMPTS_WARNING_AT = 2;

export function confirmOutcome(answer: ConfirmAnswer): ConfirmOutcome {
  switch (answer.status) {
    case "CONFIRMED":
      return { kind: "done" };
    case "CODE_INVALID":
      return { kind: "invalid", attemptsLeft: answer.attemptsLeft, showAttempts: answer.attemptsLeft <= ATTEMPTS_WARNING_AT };
    case "EXPIRED":
      return { kind: "expired" };
    case "RATE_LIMITED":
      return { kind: "rateLimited", minutes: minutesOf(answer.retryAfterSec) };
  }
}

export type ResendAnswer =
  | { readonly status: "CODE_SENT"; readonly resendAfterSec: number }
  | { readonly status: "RATE_LIMITED"; readonly retryAfterSec: number }
  | { readonly status: "EXPIRED" }
  | { readonly status: "CAPACITY" };

export type ResendOutcome =
  | { readonly kind: "sent"; readonly availableAt: number }
  | { readonly kind: "wait"; readonly minutes: number; readonly availableAt: number }
  | { readonly kind: "expired" }
  | { readonly kind: "paused" };

export function resendOutcome(answer: ResendAnswer, now: number): ResendOutcome {
  switch (answer.status) {
    case "CODE_SENT":
      return { kind: "sent", availableAt: now + answer.resendAfterSec * 1000 };
    case "RATE_LIMITED":
      return { kind: "wait", minutes: minutesOf(answer.retryAfterSec), availableAt: now + answer.retryAfterSec * 1000 };
    case "EXPIRED":
      return { kind: "expired" };
    case "CAPACITY":
      return { kind: "paused" };
  }
}
