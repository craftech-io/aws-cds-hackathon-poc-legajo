// The SMS code of every sign-in session (ADR-0021): enrolment and sign-in, the code (six digits,
// stored only as its HMAC, ten minutes, five tries, a minute between two), one account per number, the
// lead born and noticed once at enrolment, the number that never changes, automation accounts and the
// session's mark. Every SMS goes to the in-memory sender: no test sends a real one.
import { beforeEach, describe, expect, it } from "vitest";
import { PHONE_CODE } from "@legajo/shared/guest-limits";
import { NON_PERSONAL_PREFIXES } from "@legajo/shared/phone-policy";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { leadEmailHash } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { LEADS_TABLE } from "../leads/lead";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { accountPhoneKey, phoneCodeKey, phoneOwnerKey } from "./records";
import { type PhoneAccount, accountPhoneHash, endPhoneSession, isSessionCleared, phoneStatus, sendPhoneCode, verifyPhoneCode } from "./service";
import { passPhoneCode, phoneAccount } from "./testing";

const log = createLogger({ level: "error" });
const PHONE = "+5491155550101";
const EMAIL = "ana.gomez@despachos-del-sur.com.ar";
let now: Date;
let stores: MemoryStores;
let access: TestAccess;

beforeEach(() => {
  now = new Date("2026-10-14T13:30:00.000Z");
  stores = memoryStores();
  access = testAccessDeps(stores, { now: () => now });
});

const later = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
};
const ana = (overrides: Partial<PhoneAccount> = {}) => phoneAccount({ username: "usr-ana", email: EMAIL, ...overrides });
const send = (account: PhoneAccount, phone?: string) => sendPhoneCode(access, account, phone, log);
const verify = (account: PhoneAccount, code: string) => verifyPhoneCode(access, account, code, log);
const lastCode = () => access.sms.sent.at(-1)?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
const notices = () => access.invoker.invoked.filter((call) => call.target === "LeadNotice");
const consent = { accepted: true, at: "2026-10-14T13:00:00.000Z", version: "2026-10-02", lang: "es" as const };

async function draft(username = "usr-ana", phone: string | undefined = PHONE): Promise<void> {
  await access.leads.saveDraft(
    { username, email: EMAIL, emailHash: leadEmailHash(access.keys.leadEmail, EMAIL), ...(phone === undefined ? {} : { phone }), consents: { terms: { ...consent, privacyVersion: "2026-10-04" }, contact: consent }, language: "es", utm: {}, signupAt: consent.at, confirmedAt: consent.at },
    now,
  );
}

describe("[FL-134] enrolment: the first sign-in verifies the number", () => {
  it("prefills the sign-up's number, sends six digits in the account's language and stores only their HMAC", async () => {
    await draft();
    expect(await phoneStatus(access, ana())).toEqual({ status: "ENROL", phone: PHONE });
    expect(await send(ana())).toEqual({ status: "CODE_SENT", hint: "•••• 0101", resendAfterSec: PHONE_CODE.resendWaitSeconds });
    expect(access.sms.sent).toHaveLength(1);
    expect(access.sms.sent[0]?.to).toBe(PHONE);
    expect(access.sms.sent[0]?.text).toMatch(/^Tu código de Legajo listo es \d{6}\. Vence en 10 minutos\.$/);
    const stored = JSON.stringify(stores.client.dump(LEADS_TABLE).find((row) => row.SK === "CODE"));
    expect(stored).not.toContain(lastCode());
    expect(await send(ana({ sub: "sub-en", username: "usr-en", lang: "en" }), "+447700900123")).toMatchObject({ status: "CODE_SENT" });
    expect(access.sms.sent.at(-1)?.text).toMatch(/^Your Legajo listo code is \d{6}\. It expires in 10 minutes\.$/);
  });

  it("[FL-115] the right code clears the session, binds the number to the account and turns the draft into the lead with one notice", async () => {
    await draft();
    await send(ana());
    expect(await verify(ana(), lastCode())).toEqual({ status: "CLEARED" });
    expect(await isSessionCleared(access, "sub-usr-ana", "jti-1")).toBe(true);
    expect(await stores.client.get(LEADS_TABLE, accountPhoneKey("sub-usr-ana"))).toMatchObject({ phone: PHONE, verifiedAt: now.toISOString() });
    expect(await stores.client.get(LEADS_TABLE, phoneOwnerKey(accountPhoneHash(access.keys.accountPhone, PHONE)))).toMatchObject({ sub: "sub-usr-ana" });
    expect(await stores.client.get(LEADS_TABLE, phoneCodeKey("sub-usr-ana"))).toBeUndefined();
    expect(await access.leads.get(leadEmailHash(access.keys.leadEmail, EMAIL))).toMatchObject({ phone: PHONE, phoneVerifiedAt: now.toISOString(), noticeStatus: "PENDING" });
    expect(notices()).toHaveLength(1);
    expect(await phoneStatus(access, ana())).toEqual({ status: "CLEARED" });
  });

  it("accepts a corrected number while enrolling, normalized by the schema; asks for one when there is none", async () => {
    expect(await send(phoneAccount({ username: "brk-staff" }))).toEqual({ status: "PHONE_REQUIRED" });
    expect(await phoneStatus(access, phoneAccount({ username: "brk-staff" }))).toEqual({ status: "ENROL" });
    await draft();
    await send(ana(), "+5491155550199");
    expect(access.sms.sent.at(-1)?.to).toBe("+5491155550199");
  });

  it("an account whose lead existed before the phone was asked for only gets the number: no second notice", async () => {
    const leadConsents = { terms: { ...consent, privacyVersion: "2026-10-04" }, contact: consent };
    await access.leads.saveVerifiedLead({ newLeadId: "01J9ZQ00000000000000000077", email: EMAIL, emailHash: leadEmailHash(access.keys.leadEmail, EMAIL), consents: leadConsents, language: "es", utm: {}, signupAt: consent.at, confirmedAt: consent.at, cognitoUsername: "usr-ana" }, now);
    expect(await passPhoneCode(access, ana(), PHONE)).toEqual({ status: "CLEARED" });
    expect(await access.leads.get(leadEmailHash(access.keys.leadEmail, EMAIL))).toMatchObject({ phone: PHONE });
    expect(notices()).toHaveLength(0);
  });

  it.each(NON_PERSONAL_PREFIXES)("a typed %s number is refused as not a personal mobile, before any limit or SMS", async (prefix) => {
    await draft();
    expect(await send(ana(), `${prefix}12345678`)).toEqual({ status: "PHONE_NOT_PERSONAL" });
    expect(access.sms.sent).toEqual([]);
  });

  it("a filler number is refused as invalid, typed or from the sign-up's draft", async () => {
    await draft("usr-ana", "+5491100000000");
    expect(await send(ana())).toEqual({ status: "PHONE_INVALID" });
    expect(await send(ana(), "+5491155555555")).toEqual({ status: "PHONE_INVALID" });
    expect(await send(ana(), PHONE)).toMatchObject({ status: "CODE_SENT" });
    expect(access.sms.sent).toHaveLength(1);
  });
});

describe("[FL-134] the code", () => {
  beforeEach(async () => {
    await draft();
    await send(ana());
  });

  it("a wrong code says how many tries are left; the fifth wrong one closes it, and then even the right one is EXPIRED", async () => {
    const right = lastCode();
    const wrong = right === "000000" ? "111111" : "000000";
    for (let left = PHONE_CODE.maxAttempts - 1; left >= 1; left -= 1) expect(await verify(ana(), wrong)).toEqual({ status: "CODE_INVALID", attemptsLeft: left });
    expect(await verify(ana(), wrong)).toEqual({ status: "EXPIRED" });
    expect(await verify(ana(), right)).toEqual({ status: "EXPIRED" });
    expect(await isSessionCleared(access, "sub-usr-ana", "jti-1")).toBe(false);
  });

  it("expires after ten minutes, by its own date even before the table's TTL deletes it", async () => {
    const code = lastCode();
    later(PHONE_CODE.ttlSeconds + 1);
    expect(await verify(ana(), code)).toEqual({ status: "EXPIRED" });
  });

  it("another code no sooner than a minute later; the new one replaces the old", async () => {
    const first = lastCode();
    later(30);
    expect(await send(ana())).toEqual({ status: "RATE_LIMITED", limit: "RESEND", retryAfterSec: 30 });
    expect(access.sms.sent).toHaveLength(1);
    later(30);
    expect(await send(ana())).toMatchObject({ status: "CODE_SENT" });
    const second = lastCode();
    if (first !== second) expect(await verify(ana(), first)).toMatchObject({ status: "CODE_INVALID" });
    expect(await verify(ana(), second)).toEqual({ status: "CLEARED" });
  });

  it("belongs to the session it was sent for: another sign-in cannot use it", async () => {
    expect(await verify(ana({ sessionId: "jti-other" }), lastCode())).toEqual({ status: "EXPIRED" });
  });

  it("a failed SMS removes the code and says so", async () => {
    access.sms.failFor("+12025550123");
    later(60);
    expect(await send(ana(), "+12025550123")).toEqual({ status: "SEND_FAILED" });
    expect(await stores.client.get(LEADS_TABLE, phoneCodeKey("sub-usr-ana"))).toBeUndefined();
  });
});

describe("[FL-134] one number, one account", () => {
  it("a number another account verified is refused at the send and, after a race, at the verification", async () => {
    await draft();
    const bruno = phoneAccount({ username: "usr-bruno" });
    await send(bruno, PHONE);
    const brunoCode = lastCode();
    expect(await passPhoneCode(access, ana())).toEqual({ status: "CLEARED" });
    expect(await verify(bruno, brunoCode)).toEqual({ status: "PHONE_IN_USE" });
    later(60);
    expect(await send(bruno, PHONE)).toEqual({ status: "PHONE_IN_USE" });
    expect(await isSessionCleared(access, "sub-usr-bruno", "jti-1")).toBe(false);
  });
});

describe("[FL-135] every sign-in asks again: the session, not the account", () => {
  beforeEach(async () => {
    await draft();
    await passPhoneCode(access, ana());
  });

  it("a second session gets its own code, to the verified number, shown by its last digits; refreshes keep the session", async () => {
    const second = ana({ sessionId: "jti-2" });
    expect(await isSessionCleared(access, "sub-usr-ana", "jti-1")).toBe(true);
    expect(await phoneStatus(access, second)).toEqual({ status: "SIGN_IN", hint: "•••• 0101" });
    later(60);
    expect(await send(second)).toMatchObject({ status: "CODE_SENT", hint: "•••• 0101" });
    expect(access.sms.sent.at(-1)?.to).toBe(PHONE);
    expect(await verify(second, lastCode())).toEqual({ status: "CLEARED" });
    expect(notices()).toHaveLength(1);
  });

  it("the verified number never changes from a session, cleared or not", async () => {
    later(60);
    expect(await send(ana({ sessionId: "jti-2" }), "+5491155550199")).toEqual({ status: "PHONE_LOCKED" });
    expect(await send(ana(), "+5491155550199")).toEqual({ status: "CLEARED" });
    expect(await stores.client.get(LEADS_TABLE, accountPhoneKey("sub-usr-ana"))).toMatchObject({ phone: PHONE });
  });

  it("the sign-out removes the session's mark", async () => {
    await endPhoneSession(access, ana());
    expect(await isSessionCleared(access, "sub-usr-ana", "jti-1")).toBe(false);
  });
});

describe("[FL-136] automation accounts", () => {
  it("pass without a code only with the server-side mark; nothing a person sends sets it", async () => {
    const runner = phoneAccount({ username: "guest-test" });
    expect(await isSessionCleared(access, runner.sub, "any")).toBe(false);
    await access.phones.markAutomation(runner.sub, "SCENARIO_RUNNER", now);
    expect(await isSessionCleared(access, runner.sub, "any")).toBe(true);
    expect(await phoneStatus(access, runner)).toEqual({ status: "CLEARED" });
    expect(await send(runner, PHONE)).toEqual({ status: "CLEARED" });
    expect(access.sms.sent).toEqual([]);
  });
});
