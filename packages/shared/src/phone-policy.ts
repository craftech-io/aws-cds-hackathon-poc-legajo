// Which mobile numbers the SMS code may go to (ADR-0021 §15 and §17), on top of the E.164 shape of
// phone-number.ts. Kept apart from it on purpose: the sign-up form of the landing's chunk parses the
// shape only, and these lists travel with the BFF and the phone screen of the console.
//
//   the Americas    only numbers of the Americas (+1 and +5) get an SMS; any other is refused while
//                   loading or correcting it, and a verified one outside them never gets a code
//   home region     Latin American numbers share the demo's general SMS limits; the rest of the
//                   Americas also counts in the foreign quota (`SMS_LIMITS.foreign`)
//   not personal    ranges that are not people's mobiles (machine-to-machine, personal numbering,
//                   international networks, satellite) are refused while loading or correcting a number
//   filler          a number ending in seven or more equal digits is refused as an invalid number

/** Country prefixes of the home region, the Dominican Republic by its three area codes of +1. */
export const HOME_COUNTRY_PREFIXES = [
  "+54",
  "+55",
  "+56",
  "+57",
  "+52",
  "+51",
  "+598",
  "+595",
  "+591",
  "+593",
  "+58",
  "+506",
  "+507",
  "+502",
  "+503",
  "+504",
  "+505",
  "+1809",
  "+1829",
  "+1849",
] as const;

/** Country prefixes of the Americas: +1 (United States, Canada and the Caribbean) and +5 (Mexico, Cuba, Central and South America). */
export const AMERICAS_PREFIXES = ["+1", "+5"] as const;

/** Ranges that are not a person's mobile: refused with "Usá un celular personal". */
export const NON_PERSONAL_PREFIXES = ["+3197", "+4470", "+882", "+883", "+870", "+881", "+888", "+979"] as const;

/** Trailing equal digits that make a number filler (`+5491100000000`). */
export const FILLER_REPEATED_DIGITS = 7;

const FILLER = new RegExp(`(\\d)\\1{${FILLER_REPEATED_DIGITS - 1}}$`);

/** Why a well-formed E.164 number cannot be loaded as an account's mobile. */
export type PhoneRefusal = "NOT_PERSONAL" | "FILLER" | "COUNTRY_NOT_ALLOWED";

const startsWithAny = (phone: string, prefixes: readonly string[]): boolean => prefixes.some((prefix) => phone.startsWith(prefix));

/** True for a number of the Americas (E.164, already normalized): the only ones an SMS goes to. */
export function isAmericasNumber(phone: string): boolean {
  return startsWithAny(phone, AMERICAS_PREFIXES);
}

/** True for a number of the home region (E.164, already normalized). */
export function isHomeNumber(phone: string): boolean {
  return startsWithAny(phone, HOME_COUNTRY_PREFIXES);
}

/** The refusal of a normalized E.164 number, or `undefined` when it may be loaded. */
export function phoneRefusal(phone: string): PhoneRefusal | undefined {
  if (startsWithAny(phone, NON_PERSONAL_PREFIXES)) return "NOT_PERSONAL";
  if (FILLER.test(phone)) return "FILLER";
  if (!isAmericasNumber(phone)) return "COUNTRY_NOT_ALLOWED";
  return undefined;
}
