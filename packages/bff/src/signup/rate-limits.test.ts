// The limits of ADR-0015 §3.2, read from guest-limits.ts (never repeated here): every counter stops at
// its ceiling, answers when it frees, and counts nothing past it.
import { describe, expect, it } from "vitest";
import { CONFIRM_MAX_ATTEMPTS, RESEND_MAX_PER_SIGNUP, RESEND_WAIT_SECONDS, SIGNUP_RATE_LIMITS } from "@legajo/shared/guest-limits";
import { memoryStores } from "../connector/testing";
import { createLogger } from "../lib/log";
import { gateConfirm, gateEmail, gateStart } from "./rate-limits";
import { signupResend, signupConfirm } from "./service";
import { testAccessDeps } from "./testing";
import { startSignup } from "./testing-flows";

const NOW = new Date("2026-10-14T13:20:00.000Z");
const limitOf = (limits: readonly { window: string; limit: number }[], window: string) => limits.find((limit) => limit.window === window)?.limit ?? 0;
const log = createLogger({ level: "error" });

async function times<T>(count: number, run: () => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let index = 0; index < count; index += 1) out.push(await run());
  return out;
}

describe("[FL-112] signup.start per viewer IP and in total", () => {
  it("answers RATE_LIMITED past the hourly limit of one IP, until the hour ends, and counts nothing more", async () => {
    const { client } = memoryStores();
    const hourly = limitOf(SIGNUP_RATE_LIMITS.startPerIp, "HOUR");
    const allowed = await times(hourly, () => gateStart(client, "ip-a", NOW));
    expect(allowed.every((gate) => gate.status === "OK")).toBe(true);
    expect(await gateStart(client, "ip-a", NOW)).toEqual({ status: "RATE_LIMITED", retryAfterSec: 40 * 60 });
    expect(await gateStart(client, "ip-b", NOW)).toEqual({ status: "OK" });
    // The next hour opens again, up to the daily limit.
    expect(await gateStart(client, "ip-a", new Date("2026-10-14T14:00:00.000Z"))).toEqual({ status: "OK" });
  });

  it("stops one IP at its daily limit across hours", async () => {
    const { client } = memoryStores();
    const daily = limitOf(SIGNUP_RATE_LIMITS.startPerIp, "DAY");
    const hourly = limitOf(SIGNUP_RATE_LIMITS.startPerIp, "HOUR");
    let at = new Date("2026-10-14T00:05:00.000Z");
    for (let done = 0; done < daily; done += hourly) {
      await times(Math.min(hourly, daily - done), () => gateStart(client, "ip-c", at));
      at = new Date(at.getTime() + 3_600_000);
    }
    const refused = await gateStart(client, "ip-c", at);
    expect(refused.status).toBe("RATE_LIMITED");
    expect(refused.status === "RATE_LIMITED" && refused.retryAfterSec).toBe((Date.parse("2026-10-15T00:00:00.000Z") - at.getTime()) / 1000);
  });

  it("answers CAPACITY past the new sign-ups of the whole demo in an hour", async () => {
    const { client } = memoryStores();
    const total = limitOf(SIGNUP_RATE_LIMITS.startTotal, "HOUR");
    await times(total, async () => gateStart(client, `ip-${Math.random()}`, NOW));
    expect(await gateStart(client, "ip-new", NOW)).toEqual({ status: "CAPACITY" });
  });
});

describe("[FL-112] per email and per domain (decided by SignupDispatch)", () => {
  it("refuses a fourth sign-up of one email in a day and the 31st of one domain in an hour", async () => {
    const { client } = memoryStores();
    await times(limitOf(SIGNUP_RATE_LIMITS.startPerEmail, "DAY"), () => gateEmail(client, "mail-a", "dom-a", NOW));
    expect(await gateEmail(client, "mail-a", "dom-a", NOW)).toBe("EMAIL_QUOTA");
    const domain = limitOf(SIGNUP_RATE_LIMITS.startPerDomain, "HOUR");
    const used = limitOf(SIGNUP_RATE_LIMITS.startPerEmail, "DAY");
    await times(domain - used, async () => gateEmail(client, `mail-${Math.random()}`, "dom-a", NOW));
    expect(await gateEmail(client, "mail-z", "dom-a", NOW)).toBe("DOMAIN_QUOTA");
  });
});

describe("[FL-102] signup.confirm per viewer IP and per sign-up", () => {
  it("stops one IP at its hourly limit of confirmations", async () => {
    const { client } = memoryStores();
    const limit = limitOf(SIGNUP_RATE_LIMITS.confirmPerIp, "HOUR");
    await times(limit, () => gateConfirm(client, "ip-a", NOW));
    expect(await gateConfirm(client, "ip-a", NOW)).toEqual({ ok: false, retryAfterSec: 40 * 60 });
  });

  it("closes the sign-up at the fifth wrong code: EXPIRED, start again", async () => {
    const stores = memoryStores();
    const access = testAccessDeps(stores, { now: () => NOW });
    const { signupId } = await startSignup(access, { email: "ana@despachos-del-sur.com.ar" });
    const wrong = await times(CONFIRM_MAX_ATTEMPTS, () => signupConfirm(access, { signupId, code: "000000", password: "Quince-Caballos-7" }, { ipHash: "ip-a", log }));
    expect(wrong.slice(0, -1).map((answer) => answer.status)).toEqual(Array<string>(CONFIRM_MAX_ATTEMPTS - 1).fill("CODE_INVALID"));
    expect(wrong.at(-2)).toEqual({ status: "CODE_INVALID", attemptsLeft: 1 });
    expect(wrong.at(-1)).toEqual({ status: "EXPIRED" });
    const code = access.cognito.lastCode((await access.signups.get(signupId, NOW))?.accountUsername ?? "") ?? "";
    expect(await signupConfirm(access, { signupId, code, password: "Quince-Caballos-7" }, { ipHash: "ip-a", log })).toEqual({ status: "EXPIRED" });
  });
});

describe("[FL-103] signup.resend", () => {
  it("waits 60 s between resends, allows 3 per sign-up, and answers EXPIRED for an unknown one", async () => {
    let now = NOW;
    const access = testAccessDeps(memoryStores(), { now: () => now });
    const { signupId } = await startSignup(access, { email: "ana@despachos-del-sur.com.ar" });
    const ctx = { ipHash: "ip-a", log };
    expect(await signupResend(access, signupId, ctx)).toEqual({ status: "RATE_LIMITED", retryAfterSec: RESEND_WAIT_SECONDS });
    for (let sent = 0; sent < RESEND_MAX_PER_SIGNUP; sent += 1) {
      now = new Date(now.getTime() + RESEND_WAIT_SECONDS * 1000);
      expect(await signupResend(access, signupId, ctx)).toEqual({ status: "CODE_SENT", resendAfterSec: RESEND_WAIT_SECONDS });
    }
    now = new Date(now.getTime() + RESEND_WAIT_SECONDS * 1000);
    expect((await signupResend(access, signupId, ctx)).status).toBe("RATE_LIMITED");
    expect(access.invoker.invoked.filter((call) => call.payload.kind === "RESEND")).toHaveLength(RESEND_MAX_PER_SIGNUP);
    expect(await signupResend(access, "01J9ZQXA7Q2W3E4R5T6Y7V8H9G", ctx)).toEqual({ status: "EXPIRED" });
  });
});
