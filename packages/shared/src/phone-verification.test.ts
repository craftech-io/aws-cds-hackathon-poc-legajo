// The phone of the sign-up form and of the phone screen (ADR-0021 §1): E.164, any country, separators
// people type dropped before anything is stored; the code is six digits.
import { describe, expect, it } from "vitest";
import { AccountPhone, PhoneCode, SendPhoneCodeInput, phoneHint } from "./phone-verification";

describe("[FL-134] AccountPhone", () => {
  it("drops spaces, dashes, dots and brackets and keeps + and 8 to 15 digits of any country", () => {
    expect(AccountPhone.parse("+54 9 11 5555-0101")).toBe("+5491155550101");
    expect(AccountPhone.parse("+1 (202) 555.0123")).toBe("+12025550123");
    expect(AccountPhone.parse("+447700900123")).toBe("+447700900123");
    expect(AccountPhone.parse("+12345678")).toBe("+12345678");
    expect(AccountPhone.parse("+123456789012345")).toBe("+123456789012345");
  });

  it("refuses a number without +, too short, too long, starting with 0 or with letters", () => {
    for (const value of ["5491155550101", "+1234567", "+1234567890123456", "+0491155550101", "+54 9 11 CALL-ME", "+54/911"]) expect(AccountPhone.safeParse(value).success, value).toBe(false);
  });

  it("shows only the last four digits of a verified number", () => {
    expect(phoneHint("+5491155550101")).toBe("•••• 0101");
  });

  it("takes a code of exactly six digits and nothing else in the send", () => {
    expect(PhoneCode.safeParse("012345").success).toBe(true);
    expect(PhoneCode.safeParse("12345").success).toBe(false);
    expect(SendPhoneCodeInput.safeParse({ phone: "+5491155550101", sub: "other" }).success).toBe(false);
  });
});
