// Which numbers the SMS code may go to (ADR-0021 §15): the home region, the ranges that are
// not a person's mobile and the filler numbers.
import { describe, expect, it } from "vitest";
import { HOME_COUNTRY_PREFIXES, NON_PERSONAL_PREFIXES, isHomeNumber, phoneRefusal } from "./phone-policy";

describe("[FL-134] home region", () => {
  it.each(HOME_COUNTRY_PREFIXES)("%s is a home prefix", (prefix) => {
    expect(isHomeNumber(`${prefix}1234567`)).toBe(true);
  });

  it("any other country, the rest of +1 included, is outside the region", () => {
    for (const phone of ["+12025550123", "+447700900123", "+358401234567", "+31612345678", "+5999123456", "+590690123456"]) expect(isHomeNumber(phone), phone).toBe(false);
  });
});

describe("[FL-134] numbers that cannot be loaded", () => {
  it.each(NON_PERSONAL_PREFIXES)("%s is refused as not a personal mobile", (prefix) => {
    expect(phoneRefusal(`${prefix}12345678`)).toBe("NOT_PERSONAL");
  });

  it("refuses a number ending in seven or more equal digits as filler, and only that", () => {
    for (const phone of ["+5491100000000", "+5491155555555", "+34611111111"]) expect(phoneRefusal(phone), phone).toBe("FILLER");
    for (const phone of ["+5491155550101", "+5491150000001", "+5491155000000","+31612345678", "+447700900123"]) expect(phoneRefusal(phone), phone).toBeUndefined();
  });
});
