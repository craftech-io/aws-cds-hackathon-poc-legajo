// Rules of `/verify-phone` (ADR-0021): only a path of this app as the way back, what each answer shows,
// the resend countdown and where Craftech's contact is offered; both decks of texts in the same shape.
import { describe, expect, it } from "vitest";
import { PHONE_COPY } from "./copy";
import { isValidCode, minutesOf, offersContact, phoneProblem, returnTarget, secondsUntil, sendOutcome, verifyOutcome } from "./phone-model";

const NOW = 1_800_000_000_000;

describe("[FL-135] the phone screen", () => {
  it("goes back only to a path of this app, never another origin nor itself", () => {
    expect(returnTarget(new URLSearchParams("returnTo=%2Fwelcome"))).toBe("/welcome");
    expect(returnTarget(new URLSearchParams("returnTo=%2Fapp%2Faudit%3Fx%3D1"))).toBe("/app/audit?x=1");
    for (const bad of ["https://evil.example", "//evil.example", "/verify-phone?returnTo=/x", ""]) expect(returnTarget(new URLSearchParams({ returnTo: bad })), bad).toBe("/app/operations");
    expect(returnTarget(new URLSearchParams())).toBe("/app/operations");
  });

  it("tells every answer of the send and the verification", () => {
    expect(sendOutcome({ status: "CODE_SENT", hint: "•••• 0101", resendAfterSec: 60 }, NOW)).toEqual({ kind: "sent", hint: "•••• 0101", resendAt: NOW + 60_000 });
    expect(sendOutcome({ status: "RATE_LIMITED", limit: "RESEND", retryAfterSec: 30 }, NOW)).toEqual({ kind: "notice", notice: { kind: "limit", limit: "RESEND", minutes: 1 }, resendAt: NOW + 30_000 });
    expect(sendOutcome({ status: "RATE_LIMITED", limit: "perAccount", retryAfterSec: 7_200 }, NOW)).toEqual({ kind: "notice", notice: { kind: "limit", limit: "perAccount", minutes: 120 } });
    expect(sendOutcome({ status: "PHONE_LOCKED" }, NOW)).toEqual({ kind: "notice", notice: { kind: "locked" } });
    expect(sendOutcome({ status: "CLEARED" }, NOW)).toEqual({ kind: "cleared" });
    expect(verifyOutcome({ status: "CODE_INVALID", attemptsLeft: 2 })).toEqual({ kind: "notice", notice: { kind: "invalid", attemptsLeft: 2 } });
    expect(verifyOutcome({ status: "EXPIRED" })).toEqual({ kind: "notice", notice: { kind: "expired" } });
    expect(verifyOutcome({ status: "CLEARED" })).toEqual({ kind: "cleared" });
  });

  it("counts the resend down and offers the contact only where a person can help", () => {
    expect(secondsUntil(NOW + 59_200, NOW)).toBe(60);
    expect(secondsUntil(NOW - 1, NOW)).toBe(0);
    expect(secondsUntil(undefined, NOW)).toBe(0);
    expect(minutesOf(1)).toBe(1);
    expect(offersContact({ kind: "sendFailed" })).toBe(true);
    expect(offersContact({ kind: "limit", limit: "perAccount", minutes: 60 })).toBe(true);
    expect(offersContact({ kind: "limit", limit: "RESEND", minutes: 1 })).toBe(false);
    expect(offersContact({ kind: "invalid", attemptsLeft: 3 })).toBe(false);
  });

  it("checks the number and the code with the shared contract", () => {
    expect(phoneProblem("+54 9 11 5555-0101")).toBeUndefined();
    expect(phoneProblem("11 5555 0101")).toEqual({ kind: "phoneRequired" });
    expect(isValidCode("123456")).toBe(true);
    expect(isValidCode("12345")).toBe(false);
  });

  it("[FL-134] refuses a range that is not a personal mobile and a filler number before sending, and tells the BFF's refusals", () => {
    expect(phoneProblem("+31 97 0123 4567")).toEqual({ kind: "notPersonal" });
    expect(phoneProblem("+44 70 1234 5678")).toEqual({ kind: "notPersonal" });
    expect(phoneProblem("+54 9 11 0000-0000")).toEqual({ kind: "phoneRequired" });
    expect(sendOutcome({ status: "PHONE_NOT_PERSONAL" }, NOW)).toEqual({ kind: "notice", notice: { kind: "notPersonal" } });
    expect(sendOutcome({ status: "PHONE_INVALID" }, NOW)).toEqual({ kind: "notice", notice: { kind: "phoneRequired" } });
    expect(PHONE_COPY.es.errors.notPersonal).toBe("Usá un celular personal.");
  });

  it("[FL-134] the foreign quota offers Craftech's contact in both languages", () => {
    expect(sendOutcome({ status: "RATE_LIMITED", limit: "foreign", retryAfterSec: 3_600 }, NOW)).toEqual({ kind: "notice", notice: { kind: "limit", limit: "foreign", minutes: 60 } });
    expect(offersContact({ kind: "limit", limit: "foreign", minutes: 60 })).toBe(true);
    expect(PHONE_COPY.es.errors.limit("foreign", 60)).toContain("escribinos");
    expect(PHONE_COPY.en.errors.limit("foreign", 60)).toContain("write to us");
  });

  it("has both decks with the same keys", () => {
    expect(Object.keys(PHONE_COPY.en).sort()).toEqual(Object.keys(PHONE_COPY.es).sort());
    expect(Object.keys(PHONE_COPY.en.errors).sort()).toEqual(Object.keys(PHONE_COPY.es.errors).sort());
    expect(PHONE_COPY.es.errors.invalid(1)).toContain("1 intento");
  });
});
