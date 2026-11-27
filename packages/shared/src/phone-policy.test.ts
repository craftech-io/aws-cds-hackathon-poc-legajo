// Which numbers the SMS code may go to (ADR-0021 §15): the home region, the ranges that are
// not a person's mobile and the filler numbers.
import { describe, expect, it } from "vitest";
import { HOME_COUNTRY_PREFIXES, NON_PERSONAL_PREFIXES, isAmericasNumber, isHomeNumber, phoneRefusal } from "./phone-policy";

describe("[FL-134] home region", () => {
  it.each(HOME_COUNTRY_PREFIXES)("%s is a home prefix", (prefix) => {
    expect(isHomeNumber(`${prefix}1234567`)).toBe(true);
  });

  it("Spain left the region; any other country, the rest of +1 included, is outside it", () => {
    for (const phone of ["+34611223344", "+5355123456", "+50912345678", "+12025550123", "+447700900123", "+358401234567", "+31612345678", "+5999123456", "+590690123456"]) expect(isHomeNumber(phone), phone).toBe(false);
  });
});

describe("[FL-134] numbers that cannot be loaded", () => {
  it.each(NON_PERSONAL_PREFIXES)("%s is refused as not a personal mobile", (prefix) => {
    expect(phoneRefusal(`${prefix}12345678`)).toBe("NOT_PERSONAL");
  });

  it("refuses a number ending in seven or more equal digits as filler, and only that", () => {
    for (const phone of ["+5491100000000", "+5491155555555", "+34611111111"]) expect(phoneRefusal(phone), phone).toBe("FILLER");
    for (const phone of ["+5491155550101", "+5491150000001", "+5491155000000", "+12025550123"]) expect(phoneRefusal(phone), phone).toBeUndefined();
  });

  it("accepts only the Americas: +1 and +5, never Europe, Asia, Africa or Oceania", () => {
    for (const phone of ["+12025550123", "+14165550123", "+18095550123", "+5215512345678", "+5355123456", "+50912345678", "+59899123456"]) expect(isAmericasNumber(phone), phone).toBe(true);
    for (const phone of ["+34611223344", "+447700900123", "+358401234567", "+31612345678", "+819012345678", "+8613812345678", "+919812345678", "+2348012345678", "+61412345678"]) {
      expect(phoneRefusal(phone), phone).toBe("COUNTRY_NOT_ALLOWED");
    }
  });
});
