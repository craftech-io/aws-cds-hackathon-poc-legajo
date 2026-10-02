// Two signed values of the sign-up (ADR-0015 §1 and §3.1), both HMACs with their own subkey:
//
//   ticket     HMAC(K_signup-ticket, "<username>|<emailHash>|<signupId>|<exp>"), valid 120 s from when
//              `SignupDispatch` makes it, in `ValidationData` of `SignUp`. `AuthPreSignUp` recomputes it
//              before the user exists, so a `SignUp` called straight on the public client of the pool
//              creates nothing and mails nothing.
//   formToken  "<shownAtMs>.<lang>.<HMAC(K_form, …)>" from `signup.form`: when the form was shown,
//              which `SignupDispatch` compares with the 3 s – 2 h window of a human.
import { Language } from "@legajo/shared";
import { SIGNUP_TICKET_TTL_SECONDS } from "@legajo/shared/guest-limits";
import { type SecretKey, hmacSha256Base64Url, safeEqual } from "../lib/crypto";

export interface TicketSubject {
  /** `usr-<ulid>` of the user being created. */
  readonly username: string;
  /** `emailHash` (`lead-email` subkey) of the email the user is created with. */
  readonly emailHash: string;
  readonly signupId: string;
}

/** What travels in `ValidationData` (Cognito hands it to the trigger as a string map). */
export interface SignupTicket {
  readonly ticket: string;
  readonly signupId: string;
  /** Epoch seconds. */
  readonly exp: string;
}

function message(subject: TicketSubject, exp: string): string {
  return `${subject.username}|${subject.emailHash}|${subject.signupId}|${exp}`;
}

export function issueTicket(key: SecretKey, subject: TicketSubject, now: Date): SignupTicket {
  const exp = String(Math.floor(now.getTime() / 1000) + SIGNUP_TICKET_TTL_SECONDS);
  return { ticket: hmacSha256Base64Url(key, message(subject, exp)), signupId: subject.signupId, exp };
}

export type TicketVerdict = "VALID" | "MISSING" | "INVALID" | "EXPIRED";

/**
 * Recomputes the ticket for the user Cognito is about to create. `exp` must be in the future and no
 * further than the ticket's life: a ticket minted with a longer life is not ours.
 */
export function verifyTicket(key: SecretKey, subject: Omit<TicketSubject, "signupId">, data: Readonly<Record<string, string>> | undefined, now: Date): TicketVerdict {
  const ticket = data?.ticket;
  const signupId = data?.signupId;
  const exp = data?.exp;
  if (ticket === undefined || signupId === undefined || exp === undefined) return "MISSING";
  if (!/^\d{1,12}$/.test(exp) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(signupId)) return "INVALID";
  const expected = hmacSha256Base64Url(key, message({ ...subject, signupId }, exp));
  if (!safeEqual(ticket, expected)) return "INVALID";
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const expSeconds = Number(exp);
  if (expSeconds < nowSeconds) return "EXPIRED";
  if (expSeconds > nowSeconds + SIGNUP_TICKET_TTL_SECONDS) return "INVALID";
  return "VALID";
}

// ---- formToken ---------------------------------------------------------------------------------------

export function issueFormToken(key: SecretKey, lang: Language, now: Date): string {
  const shownAt = String(now.getTime());
  return `${shownAt}.${lang}.${hmacSha256Base64Url(key, `form|${shownAt}|${lang}`)}`;
}

/** When the form was shown, or `undefined` for a token that is not ours (a bot's, or a forged one). */
export function formShownAt(key: SecretKey, token: string): Date | undefined {
  const [shownAt = "", lang = "", signature = "", extra] = token.split(".");
  if (extra !== undefined || !/^\d{1,15}$/.test(shownAt) || !Language.safeParse(lang).success) return undefined;
  if (!safeEqual(signature, hmacSha256Base64Url(key, `form|${shownAt}|${lang}`))) return undefined;
  return new Date(Number(shownAt));
}
