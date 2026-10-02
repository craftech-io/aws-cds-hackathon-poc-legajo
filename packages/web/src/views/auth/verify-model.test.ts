import { CONFIRM_MAX_ATTEMPTS, RESEND_MAX_PER_SIGNUP, RESEND_WAIT_SECONDS } from "@legajo/shared/guest-limits";
import { describe, expect, it } from "vitest";
import { ATTEMPTS_WARNING_AT, completeCode, confirmOutcome, maskEmail, minutesOf, resendOutcome, resendState } from "./verify-model";

describe("[FL-101] the code screen", () => {
  it("[FL-101] masks the email enough to recognise it", () => {
    expect(maskEmail("juana@dominio.com")).toBe("j***@d***.com");
    expect(maskEmail("juana@dominio.com.ar")).toBe("j***@d***.com.ar");
    expect(maskEmail("sin-arroba")).toBe("***");
  });

  it("[FL-101] sends the code only once it has all its digits, whatever the person pasted around it", () => {
    expect(completeCode("12345")).toBeUndefined();
    expect(completeCode(" 123 456 ")).toBe("123456");
    expect(completeCode("1234567")).toBeUndefined();
  });
});

describe("[FL-103] resending the code", () => {
  const wait = RESEND_WAIT_SECONDS * 1000;

  it("[FL-103] counts down the wait the BFF set, then lets the person ask again", () => {
    expect(resendState(0, wait, 0, RESEND_MAX_PER_SIGNUP)).toEqual({ kind: "wait", seconds: RESEND_WAIT_SECONDS });
    expect(resendState(wait - 1_500, wait, 0, RESEND_MAX_PER_SIGNUP)).toEqual({ kind: "wait", seconds: 2 });
    expect(resendState(wait, wait, 0, RESEND_MAX_PER_SIGNUP)).toEqual({ kind: "ready" });
  });

  it("[FL-103] removes the button after the last resend of the sign-up", () => {
    expect(resendState(0, 0, RESEND_MAX_PER_SIGNUP - 1, RESEND_MAX_PER_SIGNUP)).toEqual({ kind: "ready" });
    expect(resendState(0, 0, RESEND_MAX_PER_SIGNUP, RESEND_MAX_PER_SIGNUP)).toEqual({ kind: "exhausted" });
  });

  it("[FL-103] maps every answer of signup.resend", () => {
    expect(resendOutcome({ status: "CODE_SENT", resendAfterSec: RESEND_WAIT_SECONDS }, 10)).toEqual({ kind: "sent", availableAt: 10 + wait });
    expect(resendOutcome({ status: "RATE_LIMITED", retryAfterSec: 30 }, 0)).toEqual({ kind: "wait", minutes: 1, availableAt: 30_000 });
    expect(resendOutcome({ status: "EXPIRED" }, 0)).toEqual({ kind: "expired" });
    expect(resendOutcome({ status: "CAPACITY" }, 0)).toEqual({ kind: "paused" });
  });
});

describe("[FL-102] a wrong, expired or exhausted code", () => {
  it("[FL-102] says the same for a wrong and an expired code, and how many attempts remain near the end", () => {
    expect(confirmOutcome({ status: "CODE_INVALID", attemptsLeft: CONFIRM_MAX_ATTEMPTS - 1 })).toEqual({ kind: "invalid", attemptsLeft: CONFIRM_MAX_ATTEMPTS - 1, showAttempts: false });
    expect(confirmOutcome({ status: "CODE_INVALID", attemptsLeft: ATTEMPTS_WARNING_AT })).toEqual({ kind: "invalid", attemptsLeft: ATTEMPTS_WARNING_AT, showAttempts: true });
    expect(confirmOutcome({ status: "EXPIRED" })).toEqual({ kind: "expired" });
  });

  it("[FL-102] turns a rate limit into whole minutes and a confirmation into done", () => {
    expect(confirmOutcome({ status: "RATE_LIMITED", retryAfterSec: 125 })).toEqual({ kind: "rateLimited", minutes: 3 });
    expect(confirmOutcome({ status: "CONFIRMED" })).toEqual({ kind: "done" });
    expect(minutesOf(1)).toBe(1);
  });
});
