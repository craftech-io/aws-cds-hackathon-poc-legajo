// The second factor of every sign-in session over HTTP (ADR-0021 §2, §14 to §16 and §19): with the
// right password and no code nothing answers but the phone procedures (403 PHONE_VERIFICATION_REQUIRED);
// the right code clears only that session; another sign-in asks again; a refreshed token of the same
// sign-in does not; the sign-out removes the mark; the number never changes; the QaDriver's principal,
// built on the server, never asks.
import { beforeEach, describe, expect, it } from "vitest";
import { qaPrincipal } from "../auth/principal";
import { seedBrokers } from "../auth/testing";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { type Bff, bffFor, call, trpcEvent } from "../signup/testing-http";
import { createConsoleCaller } from "./index";
import { serverContext } from "./trpc";

const GUEST_SUB = "5a1d0c3e-0000-4000-8000-0000000000cc";
const STAFF_SUB = "0b7f0e2e-0000-4000-8000-0000000000dd";
const NOW = new Date("2026-10-14T13:30:00.000Z");

let stores: MemoryStores;
let access: TestAccess;
let bff: Bff;

beforeEach(() => {
  stores = memoryStores();
  access = testAccessDeps(stores, { now: () => NOW });
  bff = bffFor(stores, access, undefined, { phoneGate: "real" });
});

const authTime = Math.floor(NOW.getTime() / 1000);
const guest = (jti = "jti-1") =>
  bff.issuer.idToken({ sub: GUEST_SUB, "cognito:username": "usr-01j9zq00000000000000000003", "custom:firmId": undefined, "custom:role": "GUEST", "custom:isGuest": "true", "cognito:groups": ["GUEST"], auth_time: authTime, origin_jti: jti });
const staff = (jti = "jti-s") => bff.issuer.idToken({ sub: STAFF_SUB, "cognito:username": "b0000aaaa", "custom:firmId": "firm-delta", "cognito:groups": ["BROKER"], auth_time: authTime, origin_jti: jti });
const headers = (token: string) => ({ "x-legajo-auth": `Bearer ${token}` });
const get = (path: string, token: string) => call(bff, trpcEvent("GET", `/api/${path}`, { input: {}, headers: headers(token) }));
const post = (path: string, token: string, input: unknown = {}) => call(bff, trpcEvent("POST", `/api/${path}`, { input, headers: headers(token) }));
const lastCode = () => access.sms.sent.at(-1)?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
const refused = { status: 403, error: { reason: "PHONE_VERIFICATION_REQUIRED" } };

async function pass(token: string, phone?: string): Promise<void> {
  expect(await post("account.sendPhoneCode", token, phone === undefined ? {} : { phone })).toMatchObject({ status: 200, data: { status: "CODE_SENT" } });
  expect(await post("account.verifyPhoneCode", token, { code: lastCode() })).toMatchObject({ status: 200, data: { status: "CLEARED" } });
}

describe("[FL-135] a session that has not passed the code", () => {
  it("is refused by every procedure but the phone ones and the language, for a guest without a world", async () => {
    for (const path of ["account.session", "account.usage", "account.world"]) expect(await get(path, guest()), path).toMatchObject(refused);
    expect(await post("account.ensureWorld", guest())).toMatchObject(refused);
    expect(await post("account.setLanguage", guest(), { language: "en" })).toMatchObject(refused);
    expect(access.invoker.invoked).toEqual([]);
    expect(await get("account.preferences", guest())).toMatchObject({ status: 200 });
    expect(await get("account.phoneStatus", guest())).toMatchObject({ status: 200, data: { status: "ENROL" } });
  });

  it("is refused for staff too, whatever second factor of its own the account has", async () => {
    await seedBrokers(stores, [{ firmId: "firm-delta", brokerId: "brk-delta-ana", role: "BROKER", sub: STAFF_SUB }]);
    expect(await post("account.setLanguage", staff(), { language: "en" })).toMatchObject(refused);
    await pass(staff(), "+5491155550111");
    expect(await post("account.setLanguage", staff(), { language: "en" })).toMatchObject({ status: 200 });
  });

  it("validates the number in E.164 at the edge: + and 8 to 15 digits", async () => {
    expect(await post("account.sendPhoneCode", guest(), { phone: "11 5555 0101" })).toMatchObject({ status: 400 });
    expect(await post("account.sendPhoneCode", guest(), { phone: "+12" })).toMatchObject({ status: 400 });
    expect(access.sms.sent).toEqual([]);
  });
});

describe("[FL-135] the code clears one session", () => {
  beforeEach(async () => {
    await pass(guest(), "+54 9 11 5555-0103");
  });

  it("the session that typed it reaches the app; a refreshed token of the same sign-in too", async () => {
    expect(await get("account.session", guest())).toMatchObject({ status: 200, data: { world: "NONE" } });
    // A refresh issues a new id token with the same `origin_jti` and `auth_time`.
    expect(await get("account.session", guest("jti-1"))).toMatchObject({ status: 200 });
  });

  it("another sign-in of the same account asks for its own code, sent to the verified number", async () => {
    expect(await get("account.session", guest("jti-2"))).toMatchObject(refused);
    expect(await get("account.phoneStatus", guest("jti-2"))).toMatchObject({ data: { status: "SIGN_IN", hint: "•••• 0103" } });
    const before = access.sms.sent.length;
    expect(await post("account.sendPhoneCode", guest("jti-2"))).toMatchObject({ data: { status: "CODE_SENT", hint: "•••• 0103" } });
    expect(access.sms.sent.slice(before).map((sms) => sms.to)).toEqual(["+5491155550103"]);
    expect(await post("account.verifyPhoneCode", guest("jti-2"), { code: lastCode() })).toMatchObject({ data: { status: "CLEARED" } });
    expect(await get("account.session", guest("jti-2"))).toMatchObject({ status: 200 });
  });

  it("the number cannot be changed with the token, cleared or not", async () => {
    expect(await post("account.sendPhoneCode", guest("jti-2"), { phone: "+5491155550199" })).toMatchObject({ data: { status: "PHONE_LOCKED" } });
    expect(await post("account.sendPhoneCode", guest(), { phone: "+5491155550199" })).toMatchObject({ data: { status: "CLEARED" } });
  });

  it("the sign-out removes the mark: the same session is refused again", async () => {
    expect(await post("account.endPhoneSession", guest())).toMatchObject({ status: 200, data: { ended: true } });
    expect(await get("account.session", guest())).toMatchObject(refused);
  });
});

describe("[FL-136] automation", () => {
  it("the QaDriver's principal, built on the server, never asks for a code", async () => {
    await seedBrokers(stores, [{ firmId: "firm-qa", brokerId: "brk-qa-runner", role: "BROKER", sub: "qa" }]);
    const caller = createConsoleCaller(serverContext({ principal: qaPrincipal({ role: "BROKER", now: NOW }), deps: { ...bff.deps, phoneGate: () => Promise.resolve(false) }, access: () => access }));
    await expect(caller.account.setLanguage({ language: "en" })).resolves.toEqual({ language: "en" });
  });
});
