// The operator's block (ADR-0021 §16): an account blocked by scripts/console/block.ts reaches nothing
// with a token that is still valid and a session that already passed the SMS code. Every procedure
// answers 403 `ACCOUNT_BLOCKED`, the phone ones included, so no SMS goes out and no code is taken; only
// the account's language and the sign-out of the phone session answer. The mark beats the automation
// mark too, and lifting it gives the account back what it had.
import { beforeEach, describe, expect, it } from "vitest";
import { seedBrokers } from "../auth/testing";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { type Bff, bffFor, call, trpcEvent } from "../signup/testing-http";

const GUEST_SUB = "5a1d0c3e-0000-4000-8000-0000000000ee";
const STAFF_SUB = "0b7f0e2e-0000-4000-8000-0000000000ff";
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
const guest = () =>
  bff.issuer.idToken({ sub: GUEST_SUB, "cognito:username": "usr-01j9zq00000000000000000009", "custom:firmId": undefined, "custom:role": "GUEST", "custom:isGuest": "true", "cognito:groups": ["GUEST"], auth_time: authTime, origin_jti: "jti-1" });
const staff = () => bff.issuer.idToken({ sub: STAFF_SUB, "cognito:username": "b0000bbbb", "custom:firmId": "firm-delta", "cognito:groups": ["BROKER"], auth_time: authTime, origin_jti: "jti-s" });
const headers = (token: string) => ({ "x-legajo-auth": `Bearer ${token}` });
const get = (path: string, token: string, input: unknown = {}) => call(bff, trpcEvent("GET", `/api/${path}`, { input, headers: headers(token) }));
const post = (path: string, token: string, input: unknown = {}) => call(bff, trpcEvent("POST", `/api/${path}`, { input, headers: headers(token) }));
const lastCode = () => access.sms.sent.at(-1)?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
const blocked = { status: 403, error: { reason: "ACCOUNT_BLOCKED" } };

async function pass(token: string, phone: string): Promise<void> {
  expect(await post("account.sendPhoneCode", token, { phone })).toMatchObject({ status: 200, data: { status: "CODE_SENT" } });
  expect(await post("account.verifyPhoneCode", token, { code: lastCode() })).toMatchObject({ status: 200, data: { status: "CLEARED" } });
}

describe("[FL-137] a blocked account with a valid token and a cleared session", () => {
  beforeEach(async () => {
    await pass(guest(), "+5491155550141");
    expect(await get("account.session", guest())).toMatchObject({ status: 200 });
    await access.phones.setBlocked(GUEST_SUB, true, NOW);
  });

  it("is refused by every procedure, the account's own and the session's", async () => {
    for (const path of ["account.session", "account.usage", "account.world"]) expect(await get(path, guest()), path).toMatchObject(blocked);
    expect(await post("account.ensureWorld", guest())).toMatchObject(blocked);
    expect(await post("account.setLanguage", guest(), { language: "en" })).toMatchObject(blocked);
    expect(access.invoker.invoked.filter((call) => call.target !== "LeadNotice")).toEqual([]);
  });

  it("gets no SMS and no code is taken, even after the session's mark is gone", async () => {
    const sent = access.sms.sent.length;
    expect(await get("account.phoneStatus", guest())).toMatchObject(blocked);
    expect(await post("account.sendPhoneCode", guest())).toMatchObject(blocked);
    expect(await post("account.verifyPhoneCode", guest(), { code: "123456" })).toMatchObject(blocked);
    await access.phones.endAllSessions(GUEST_SUB);
    expect(await post("account.sendPhoneCode", guest())).toMatchObject(blocked);
    expect(access.sms.sent).toHaveLength(sent);
  });

  it("still gets its language and can sign out of the phone session, which the web needs for the notice", async () => {
    expect(await get("account.preferences", guest())).toMatchObject({ status: 200 });
    expect(await post("account.endPhoneSession", guest())).toMatchObject({ status: 200, data: { ended: true } });
  });

  it("gets back what it had once the operator lifts the block", async () => {
    await access.phones.setBlocked(GUEST_SUB, false, NOW);
    expect(await get("account.session", guest())).toMatchObject({ status: 200 });
    expect(await get("account.phoneStatus", guest())).toMatchObject({ status: 200, data: { status: "CLEARED" } });
  });
});

describe("[FL-138] the gate's named security decisions", () => {
  it("writes AccountBlocked and PhoneVerificationRequired with the path and nothing personal", async () => {
    const lines: string[] = [];
    const logged = bffFor(stores, access, lines, { phoneGate: "real" });
    const token = logged.issuer.idToken({ sub: GUEST_SUB, "cognito:username": "usr-01j9zq00000000000000000009", "custom:firmId": undefined, "custom:role": "GUEST", "custom:isGuest": "true", "cognito:groups": ["GUEST"], auth_time: authTime, origin_jti: "jti-9" });
    await call(logged, trpcEvent("GET", "/api/account.session", { input: {}, headers: headers(token) }));
    await access.phones.setBlocked(GUEST_SUB, true, NOW);
    await call(logged, trpcEvent("POST", "/api/account.sendPhoneCode", { input: { phone: "+5491155550149" }, headers: headers(token) }));
    const metrics = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => typeof line.metric === "string");
    expect(metrics).toEqual([expect.objectContaining({ metric: "PhoneVerificationRequired", path: "account.session" }), expect.objectContaining({ metric: "AccountBlocked", path: "account.sendPhoneCode" })]);
    expect(lines.join("\n")).not.toContain("5491155550149");
  });
});

describe("[FL-137] the block for staff and for automation accounts", () => {
  it("cuts a broker's firm procedures in the act", async () => {
    await seedBrokers(stores, [{ firmId: "firm-delta", brokerId: "brk-delta-bea", role: "BROKER", sub: STAFF_SUB }]);
    await pass(staff(), "+5491155550142");
    expect((await get("operations.list", staff())).status).not.toBe(403);
    await access.phones.setBlocked(STAFF_SUB, true, NOW);
    expect(await get("operations.list", staff())).toMatchObject(blocked);
    expect(await post("account.setLanguage", staff(), { language: "en" })).toMatchObject(blocked);
  });

  it("wins over the automation mark", async () => {
    await access.phones.markAutomation(GUEST_SUB, "SCENARIO_RUNNER", NOW);
    expect(await get("account.session", guest())).toMatchObject({ status: 200 });
    await access.phones.setBlocked(GUEST_SUB, true, NOW);
    expect(await get("account.session", guest())).toMatchObject(blocked);
    await access.phones.setBlocked(GUEST_SUB, false, NOW);
    expect(await access.phones.getAccount(GUEST_SUB)).toMatchObject({ automation: "SCENARIO_RUNNER" });
  });
});
