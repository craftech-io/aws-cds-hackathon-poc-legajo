// Contract of the SMS code that guards every sign-in session (ADR-0021; docs/tool-catalog.md
// "Verificación del celular"): the phone the sign-up form asks for, and the inputs and answers of
// `account.phoneStatus`, `account.sendPhoneCode`, `account.verifyPhoneCode` and `account.endPhoneSession`.
// The BFF validates every request with these schemas and the screens run the same ones in the browser.
//
//   ENROL    the account has no verified phone yet: the person types (or corrects) the number
//   SIGN_IN  the account has one: the code goes to it, shown only by its last digits, never changed
//   CLEARED  this sign-in session already passed the code
import { z } from "zod";
import { PHONE_CODE, type SmsLimit } from "./guest-limits";
import { AccountPhone } from "./phone-number";

export { AccountPhone, E164, PHONE_DIGITS } from "./phone-number";

/** What the screen shows of a verified number: its last four digits. */
export function phoneHint(phone: string): string {
  return `•••• ${phone.slice(-4)}`;
}

export const PhoneCode = z.string().regex(new RegExp(`^[0-9]{${PHONE_CODE.digits}}$`), `expected ${PHONE_CODE.digits} digits`);

export const PhoneStatusOutput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("CLEARED") }),
  /** `phone`: the number of the sign-up form, to prefill; absent for accounts created before it. */
  z.object({ status: z.literal("ENROL"), phone: z.string().optional() }),
  z.object({ status: z.literal("SIGN_IN"), hint: z.string() }),
]);
export type PhoneStatusOutput = z.infer<typeof PhoneStatusOutput>;

/** `phone` only while enrolling (a corrected number); with a verified number it is refused (`PHONE_LOCKED`). */
export const SendPhoneCodeInput = z.object({ phone: AccountPhone.optional() }).strict();
export type SendPhoneCodeInput = z.input<typeof SendPhoneCodeInput>;

/** Which limit of `SMS_LIMITS` was hit, or the minute between two codes (`RESEND`). */
export const SmsLimitName = z.enum(["perAccount", "perNumber", "perIp", "total", "foreign", "RESEND"] satisfies readonly (SmsLimit | "RESEND")[]);
export type SmsLimitName = z.infer<typeof SmsLimitName>;

export const SendPhoneCodeOutput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("CODE_SENT"), hint: z.string(), resendAfterSec: z.number().int().min(0) }),
  z.object({ status: z.literal("RATE_LIMITED"), limit: SmsLimitName, retryAfterSec: z.number().int().min(1) }),
  /** The number already verified another account. */
  z.object({ status: z.literal("PHONE_IN_USE") }),
  /** A number was sent while the account already has a verified one: only an administrator changes it. */
  z.object({ status: z.literal("PHONE_LOCKED") }),
  /** Enrolling without a number: the screen asks for it. */
  z.object({ status: z.literal("PHONE_REQUIRED") }),
  /** A filler number (phone-policy.ts): refused as an invalid number, the screen asks for another. */
  z.object({ status: z.literal("PHONE_INVALID") }),
  /** A range that is not a person's mobile (phone-policy.ts): "Usá un celular personal". */
  z.object({ status: z.literal("PHONE_NOT_PERSONAL") }),
  /** The SMS could not be delivered (a country that needs a registered sender, a number that does not exist). */
  z.object({ status: z.literal("SEND_FAILED") }),
  z.object({ status: z.literal("CLEARED") }),
]);
export type SendPhoneCodeOutput = z.infer<typeof SendPhoneCodeOutput>;

export const VerifyPhoneCodeInput = z.object({ code: PhoneCode }).strict();

export const VerifyPhoneCodeOutput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("CLEARED") }),
  z.object({ status: z.literal("CODE_INVALID"), attemptsLeft: z.number().int().min(1) }),
  /** No code alive: never sent, past ten minutes, or the fifth wrong try closed it. */
  z.object({ status: z.literal("EXPIRED") }),
  z.object({ status: z.literal("PHONE_IN_USE") }),
]);
export type VerifyPhoneCodeOutput = z.infer<typeof VerifyPhoneCodeOutput>;
