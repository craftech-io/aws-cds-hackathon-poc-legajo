// The public sign-up over HTTP, through the Lambda entry (origin check, route facts, tRPC, zod) with the
// in-memory connector and Cognito double (ADR-0015 §1 to §3; docs/tool-catalog.md "Alta pública").
import { beforeEach, describe, expect, it } from "vitest";
import { NON_CONFIRMED_RESPONSE_MS, RESEND_WAIT_SECONDS, SIGNUP_RATE_LIMITS } from "@legajo/shared/guest-limits";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { leadEmailHash } from "../lib/crypto";
import { LEADS_TABLE } from "../leads/lead";
import { type TestAccess, edgeHeaders, testAccessDeps } from "../signup/testing";
import { TEST_PASSWORD, drainDispatch, validForm } from "../signup/testing-flows";
import { type Bff, bffFor, call, trpcEvent } from "../signup/testing-http";

const EMAIL = "ana.gomez@despachos-del-sur.com.ar";
let stores: MemoryStores;
let access: TestAccess;
let bff: Bff;
let now: Date;

beforeEach(() => {
  now = new Date("2026-10-14T13:30:00.000Z");
  stores = memoryStores();
  access = testAccessDeps(stores, { now: () => now });
  bff = bffFor(stores, access);
});

const start = (input: unknown, viewer?: string) => call(bff, trpcEvent("POST", "/api/signup.start", { input, ...(viewer === undefined ? {} : { edge: edgeHeaders(viewer) }) }));
const confirm = (signupId: string, code: string) => call(bff, trpcEvent("POST", "/api/signup.confirm", { input: { signupId, code, password: TEST_PASSWORD } }));
const signupIdOf = (data: unknown) => (data as { signupId: string }).signupId;
const leadOf = (email: string) => access.leads.get(leadEmailHash(access.keys.leadEmail, email));
const codeOf = async (signupId: string) => access.cognito.lastCode((await access.signups.get(signupId, now))?.accountUsername ?? "") ?? "";

describe("[FL-101] sign-up with a new email, end to end", () => {
  it("form → start → the code → confirm → the lead; no call to Cognito on the answer's path", async () => {
    const form = await call(bff, trpcEvent("GET", "/api/signup.form", { input: { lang: "es" } }));
    expect(form.status).toBe(200);
    expect((form.data as { formToken: string }).formToken).toMatch(/^\d+\.es\./);
    const started = await start(validForm(access, { email: EMAIL }));
    expect(started).toMatchObject({ status: 200, data: { status: "CODE_SENT", resendAfterSec: RESEND_WAIT_SECONDS } });
    expect(access.cognito.calls).toEqual([]);
    await drainDispatch(access);
    const signupId = signupIdOf(started.data);
    expect(await confirm(signupId, await codeOf(signupId))).toMatchObject({ status: 200, data: { status: "CONFIRMED" } });
    expect(await leadOf(EMAIL)).toMatchObject({ email: EMAIL, sourcePoc: "legajo-listo" });
    expect(stores.client.dump(LEADS_TABLE).some((row) => JSON.stringify(row).includes(TEST_PASSWORD))).toBe(false);
  });

  it("[FL-104] answers an email with an account exactly like a new one", async () => {
    access.cognito.seed({ username: "usr-guest", email: EMAIL, groups: ["GUEST"] });
    const existing = await start(validForm(access, { email: EMAIL }));
    const fresh = await start(validForm(access, { email: "otra.persona@despachos-del-sur.com.ar" }));
    const shape = (result: typeof existing) => ({ status: result.status, keys: Object.keys(result.data as object).sort(), state: (result.data as { status: string }).status });
    expect(shape(existing)).toEqual(shape(fresh));
  });
});

describe("[FL-102] a wrong or expired code", () => {
  it("answers CODE_INVALID with the attempts left, 1.5 s after the request started, and creates nothing", async () => {
    const signupId = signupIdOf((await start(validForm(access, { email: EMAIL }))).data);
    await drainDispatch(access);
    access.slept.length = 0;
    expect(await confirm(signupId, "000000")).toMatchObject({ status: 200, data: { status: "CODE_INVALID", attemptsLeft: 4 } });
    expect(access.slept).toEqual([NON_CONFIRMED_RESPONSE_MS]);
    expect(await leadOf(EMAIL)).toBeUndefined();
    expect(await access.signups.get(signupId, now)).toMatchObject({ attempts: 1 });
    expect(await confirm("01J9ZQXA7Q2W3E4R5T6Y7V8H9G", "123456")).toMatchObject({ data: { status: "EXPIRED" } });
  });
});

describe("[FL-103] resending the code", () => {
  it("refuses a resend before 60 s and sends one after, without calling Cognito on the answer's path", async () => {
    const signupId = signupIdOf((await start(validForm(access, { email: EMAIL }))).data);
    await drainDispatch(access);
    const resend = () => call(bff, trpcEvent("POST", "/api/signup.resend", { input: { signupId } }));
    expect(await resend()).toMatchObject({ data: { status: "RATE_LIMITED", retryAfterSec: RESEND_WAIT_SECONDS } });
    now = new Date(now.getTime() + RESEND_WAIT_SECONDS * 1000);
    const calls = access.cognito.calls.length;
    expect(await resend()).toMatchObject({ data: { status: "CODE_SENT", resendAfterSec: RESEND_WAIT_SECONDS } });
    expect(access.cognito.calls).toHaveLength(calls);
    await drainDispatch(access);
    expect(access.cognito.codes.map((code) => code.kind)).toEqual(["SIGNUP", "RESEND"]);
  });
});

describe("[FL-106] an account that never confirmed", () => {
  it("a new sign-up of the same email replaces the UNCONFIRMED user: one user per email", async () => {
    await start(validForm(access, { email: EMAIL }));
    await drainDispatch(access);
    now = new Date(now.getTime() + 3_600_000);
    await start(validForm(access, { email: EMAIL }));
    await drainDispatch(access);
    expect([...access.cognito.users.values()].filter((user) => user.email === EMAIL)).toHaveLength(1);
  });
});

describe("[FL-112] limits by viewer IP", () => {
  it("refuses a request without a viewer address with 400 INVALID", async () => {
    const result = await call(bff, trpcEvent("POST", "/api/signup.start", { input: validForm(access), edge: { "x-origin-verify": edgeHeaders()["x-origin-verify"] ?? "" } }));
    expect(result).toMatchObject({ status: 400, error: { reason: "NO_VIEWER_IP" } });
  });

  it("answers RATE_LIMITED to one IP past its hourly limit; another port of the same IP counts as the same", async () => {
    const hourly = SIGNUP_RATE_LIMITS.startPerIp[0].limit;
    for (let index = 0; index < hourly; index += 1) await start(validForm(access, { email: `p${index}@despachos-del-sur.com.ar` }), `198.51.100.10:${4_000 + index}`);
    expect(await start(validForm(access), "198.51.100.10:9999")).toMatchObject({ data: { status: "RATE_LIMITED" } });
    expect(await start(validForm(access), "198.51.100.11:9999")).toMatchObject({ data: { status: "CODE_SENT" } });
  });
});

describe("[FL-113] bots learn nothing", () => {
  it("a filled honeypot gets the same CODE_SENT and nobody is mailed", async () => {
    const result = await start(validForm(access, { email: EMAIL, website: "https://spam.example-fict.com" }));
    expect(result).toMatchObject({ status: 200, data: { status: "CODE_SENT" } });
    await drainDispatch(access);
    expect(access.cognito.codes).toEqual([]);
  });

  it("a sign-up procedure called on another route is refused before it runs", async () => {
    const result = await call(bff, trpcEvent("POST", "/api/signup.start", { input: validForm(access), query: "batch=1" }));
    expect(result.status).toBe(400);
    expect(access.invoker.invoked).toEqual([]);
  });
});

describe("[FL-119] consents", () => {
  it("(a) the terms box unticked is INVALID with the field named", async () => {
    const result = await start({ ...validForm(access), consents: { terms: false, contact: true } });
    expect(result).toMatchObject({ status: 400, error: { reason: "INVALID" } });
    expect(JSON.stringify(result.error?.zodError)).toContain("consents");
  });

  it("(b) and (c) store each box with its date, version and language", async () => {
    for (const [email, contact] of [["b@despachos-del-sur.com.ar", false], ["c@despachos-del-sur.com.ar", true]] as const) {
      const signupId = signupIdOf((await start(validForm(access, { email, lang: "en", consents: { terms: true, contact } }))).data);
      await drainDispatch(access);
      await confirm(signupId, await codeOf(signupId));
      expect((await leadOf(email))?.consents).toEqual({
        terms: { accepted: true, at: now.toISOString(), version: access.legalVersions.terms, privacyVersion: access.legalVersions.privacy, lang: "en" },
        contact: { accepted: contact, at: now.toISOString(), version: access.legalVersions.contact, lang: "en" },
      });
    }
  });

  it("(d) versions other than the texts in force are refused: the page must be reloaded", async () => {
    const result = await start({ ...validForm(access), consentVersions: { ...access.legalVersions, contact: "2020-01-01" } });
    expect(result).toMatchObject({ status: 400, error: { reason: "CONSENT_VERSIONS_OUTDATED" } });
    expect(access.invoker.invoked).toEqual([]);
  });
});

describe("[FL-130] origin of the visit", () => {
  it("keeps the clean utm values and the referrer's scheme and host; drops our own origin", async () => {
    const signupId = signupIdOf((await start(validForm(access, { email: EMAIL, utm: { source: "qa", campaign: "sc26", content: "<b>" }, referrer: "https://news.example-fict.com/a?b=c" }))).data);
    await drainDispatch(access);
    await confirm(signupId, await codeOf(signupId));
    expect(await leadOf(EMAIL)).toMatchObject({ utm: { source: "qa", campaign: "sc26" }, referrer: "https://news.example-fict.com" });
    const own = signupIdOf((await start(validForm(access, { email: "d@despachos-del-sur.com.ar", referrer: "https://legajo.demo.craftech.io/" }))).data);
    expect((await access.signups.get(own, now))?.referrer).toBeUndefined();
  });
});
