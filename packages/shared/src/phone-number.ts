// The mobile number of an account (ADR-0021 §1), alone in its module: the sign-up form of the landing's
// chunk needs it without the rest of the phone contract (phone-verification.ts).
import { z } from "zod";

/** Spaces, dashes, dots and brackets people type inside a number; anything else is refused. */
const PHONE_SEPARATORS = /[\s\-.()]/g;

/** Digits of an E.164 number, country code included. */
export const PHONE_DIGITS = { min: 8, max: 15 } as const;

/** `+` and 8 to 15 digits (E.164); the first digit of the country code is never 0. */
export const E164 = new RegExp(`^\\+[1-9][0-9]{${PHONE_DIGITS.min - 1},${PHONE_DIGITS.max - 1}}$`);

/** The number as stored: separators dropped, then E.164 or a refusal. */
export const AccountPhone = z
  .string()
  .max(32)
  .transform((value) => value.replace(PHONE_SEPARATORS, ""))
  .pipe(z.string().regex(E164, "expected + and 8 to 15 digits"));
export type AccountPhone = z.output<typeof AccountPhone>;

