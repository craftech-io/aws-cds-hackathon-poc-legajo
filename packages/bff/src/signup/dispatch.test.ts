// SignupDispatch (ADR-0015 §1, §1.1, §1.2 and §1.4): every row of the classification table, every
// suppression, idempotency by `dispatchSeq`, and what it never does: write a lead, invoke LeadNotice,
// keep the sealed password, or call Cognito to write anything for an account it must not touch.
import { beforeEach, describe, expect, it } from "vitest";
import { SIGNUP_RATE_LIMITS } from "@legajo/shared/guest-limits";
import { RUNTIME_TABLE } from "./counters";
import { mailStatusKey, MAIL_BREAKER_KEY } from "../channels/email/mail-status";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { leadEmailHash } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { LEADS_TABLE, signupKey } from "../leads/lead";
import { runDispatch } from "./dispatch";
import { type TestAccess, cognitoWrites, fakeMx, testAccessDeps } from "./testing";
import { drainDispatch, startSignup, validForm } from "./testing-flows";
import { signupResend, signupStart } from "./service";
import { SignupStartInput } from "@legajo/shared/signup";

const NOW = new Date("2026-10-14T13:30:00.000Z");
const EMAIL = "ana.gomez@despachos-del-sur.com.ar";

let stores: MemoryStores;
let access: TestAccess;
let lines: string[];
const log = () => createLogger({ level: "debug", sink: (line) => lines.push(line) });
const metrics = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.metric !== undefined);

beforeEach(() => {
  stores = memoryStores();
  access = testAccessDeps(stores, { now: () => NOW, mx: fakeMx(["sin-correo.example-fict.com"]) });
  lines = [];
});

async function stored(signupId: string) {
  return stores.client.get(LEADS_TABLE, signupKey(signupId));
}

function leadsWritten(): number {
  return stores.client.dump(LEADS_TABLE).filter((row) => row.entity === "Lead").length;
}

describe("[FL-101] a new email", () => {
  it("removes the sealed password first, signs up with the ticket and records NEW; no lead, no notice", async () => {
    const { signupId, answer } = await startSignup(access, { email: EMAIL }, "ip-a", log());
    expect(answer).toMatchObject({ status: "CODE_SENT" });
    const signup = await stored(signupId);
    expect(signup).toMatchObject({ branch: "NEW", dispatchedSeq: 1 });
    expect(signup?.passwordSealed).toBeUndefined();
    expect(access.cognito.calls).toEqual(["findByEmail", "signUp"]);
    const user = access.cognito.users.get(String(signup?.username));
    expect(user).toMatchObject({ status: "UNCONFIRMED", email: EMAIL, locale: "es", groups: [] });
    expect(access.cognito.codes).toEqual([expect.objectContaining({ kind: "SIGNUP", username: signup?.username, clientMetadata: { lang: "es" } })]);
    expect(leadsWritten()).toBe(0);
    expect(access.invoker.invoked.map((call) => call.target)).toEqual(["SignupDispatch"]);
  });

  it("[FL-104] replaces an UNCONFIRMED user without groups: deleted (fenced), then a new SignUp", async () => {
    access.cognito.seed({ username: "usr-old", email: EMAIL, status: "UNCONFIRMED" });
    const { signupId } = await startSignup(access, { email: EMAIL });
    expect(await stored(signupId)).toMatchObject({ branch: "NEW" });
    expect(access.cognito.users.has("usr-old")).toBe(false);
    expect(cognitoWrites(access.cognito.calls)).toEqual(["deleteUnconfirmed", "signUp"]);
  });
});

describe("[FL-104] an email that already has an account", () => {
  it("a public guest gets ForgotPassword with intent signup-existing, in its language", async () => {
    access.cognito.seed({ username: "usr-guest", email: EMAIL, groups: ["GUEST"] });
    const { signupId } = await startSignup(access, { email: EMAIL, lang: "en" });
    expect(await stored(signupId)).toMatchObject({ branch: "EXISTING_GUEST", accountUsername: "usr-guest" });
    expect((await stored(signupId))?.passwordSealed).toBeUndefined();
    expect(cognitoWrites(access.cognito.calls)).toEqual(["forgotPassword"]);
    expect(access.cognito.codes).toEqual([expect.objectContaining({ kind: "FORGOT", username: "usr-guest", clientMetadata: { lang: "en", intent: "signup-existing" } })]);
  });

  it.each([
    ["a broker", { groups: ["BROKER"], firmId: "firm-delta" }],
    ["an analyst", { groups: ["ANALYST"], firmId: "firm-delta" }],
    ["a reserved guest (it has a firm)", { groups: ["GUEST"], firmId: "firm-guest-07" }],
    ["guest-test", { groups: ["GUEST"], firmId: "firm-guest-test" }],
    ["a user in FORCE_CHANGE_PASSWORD", { status: "FORCE_CHANGE_PASSWORD", groups: ["GUEST"] }],
    ["a user in RESET_REQUIRED", { status: "RESET_REQUIRED", groups: ["GUEST"] }],
    ["a user with two groups", { groups: ["GUEST", "ANALYST"] }],
    ["a disabled guest", { groups: ["GUEST"], enabled: false }],
    ["an UNCONFIRMED user with a group", { status: "UNCONFIRMED", groups: ["GUEST"] }],
  ])("%s is INELIGIBLE: only reads, no email, no group, no lead", async (_label, user) => {
    access.cognito.seed({ username: "usr-existing", email: EMAIL, ...user });
    const { signupId, answer } = await startSignup(access, { email: EMAIL }, "ip-a", log());
    expect(answer).toMatchObject({ status: "CODE_SENT" });
    expect(await stored(signupId)).toMatchObject({ branch: "INELIGIBLE" });
    expect((await stored(signupId))?.passwordSealed).toBeUndefined();
    expect(cognitoWrites(access.cognito.calls)).toEqual([]);
    expect(access.cognito.codes).toEqual([]);
    expect(access.cognito.users.get("usr-existing")?.groups).toEqual(user.groups);
    expect(leadsWritten()).toBe(0);
    expect(metrics()).toContainEqual(expect.objectContaining({ metric: "SignupRejected", reason: "INELIGIBLE" }));
  });
});

describe("[FL-114] suppressed before Cognito is asked anything", () => {
  it.each([
    ["a reserved domain", { email: "ana@empresa.test" }, "RESERVED_DOMAIN"],
    ["our own domain", { email: "ana@sim.legajo.demo.craftech.io" }, "OWN_DOMAIN"],
    ["a domain without MX", { email: "ana@sin-correo.example-fict.com" }, "NO_MX"],
    ["the honeypot", { website: "https://spam.example-fict.com" }, "HONEYPOT"],
  ])("%s → SUPPRESSED, the same CODE_SENT, nothing sent", async (_label, overrides, reason) => {
    const { signupId, answer } = await startSignup(access, overrides, "ip-a", log());
    expect(answer).toMatchObject({ status: "CODE_SENT" });
    const signup = await stored(signupId);
    expect(signup).toMatchObject({ branch: "SUPPRESSED" });
    expect(signup?.passwordSealed).toBeUndefined();
    expect(access.cognito.calls).toEqual([]);
    expect(metrics()).toContainEqual(expect.objectContaining({ metric: "SignupRejected", reason }));
  });

  it("a domain whose only MX is the null MX of RFC 7505", async () => {
    access = testAccessDeps(stores, { now: () => NOW, mx: async (domain) => (domain === "nulo.example-fict.com" ? [{ exchange: ".", priority: 0 }] : [{ exchange: `mx.${domain}`, priority: 10 }]) });
    const { signupId } = await startSignup(access, { email: "ana@nulo.example-fict.com" }, "ip-a", log());
    expect(await stored(signupId)).toMatchObject({ branch: "SUPPRESSED" });
    expect(metrics()).toContainEqual(expect.objectContaining({ reason: "NO_MX" }));
    expect(access.cognito.calls).toEqual([]);
  });

  it("a form sent in less than 3 s is suppressed", async () => {
    const form = { ...validForm(access), formToken: validForm({ ...access, now: () => new Date(NOW.getTime() + 9_000) } as TestAccess).formToken };
    const answer = await signupStart(access, SignupStartInput.parse(form), { ipHash: "ip-a", log: log() });
    expect(answer.status).toBe("CODE_SENT");
    await runDispatch(access, access.invoker.invoked[0]?.payload, log());
    expect(await stored(answer.status === "CODE_SENT" ? answer.signupId : "")).toMatchObject({ branch: "SUPPRESSED" });
    expect(metrics()).toContainEqual(expect.objectContaining({ reason: "TOO_FAST" }));
  });

  it("a recipient that bounced or complained, and an open breaker", async () => {
    await stores.client.put(RUNTIME_TABLE, { ...mailStatusKey(leadEmailHash(access.keys.leadEmail, EMAIL)), entity: "MailStatus", status: "BOUNCED", at: NOW.toISOString(), count: 1 });
    expect(await stored((await startSignup(access, { email: EMAIL })).signupId)).toMatchObject({ branch: "SUPPRESSED" });
    // The breaker opens between the answer and the dispatch.
    const answer = await signupStart(access, SignupStartInput.parse(validForm(access, { email: "otra@despachos-del-sur.com.ar" })), { ipHash: "ip-b", log: log() });
    await stores.client.put(RUNTIME_TABLE, { ...MAIL_BREAKER_KEY, entity: "MailBreaker", state: "OPEN", openedAt: NOW.toISOString() });
    await runDispatch(access, access.invoker.invoked.at(-1)?.payload, log());
    expect(await stored(answer.status === "CODE_SENT" ? answer.signupId : "")).toMatchObject({ branch: "SUPPRESSED" });
    expect(access.cognito.calls).toEqual([]);
    expect(metrics()).toContainEqual(expect.objectContaining({ reason: "BREAKER_OPEN" }));
  });

  it("the fourth sign-up of one email in a day", async () => {
    const limit = SIGNUP_RATE_LIMITS.startPerEmail[0].limit;
    for (let index = 0; index < limit; index += 1) await startSignup(access, { email: EMAIL }, `ip-${index}`);
    const { signupId } = await startSignup(access, { email: EMAIL }, "ip-last");
    expect(await stored(signupId)).toMatchObject({ branch: "SUPPRESSED" });
  });
});

describe("[FL-101] idempotent by dispatchSeq, never retried by Lambda", () => {
  it("a repeated or stale event does nothing", async () => {
    const { signupId } = await startSignup(access, { email: EMAIL });
    const calls = access.cognito.calls.length;
    expect(await runDispatch(access, { kind: "START", signupId, dispatchSeq: 1 }, log())).toEqual({ outcome: "STALE" });
    expect(await runDispatch(access, { kind: "START", signupId, dispatchSeq: 7 }, log())).toEqual({ outcome: "STALE" });
    expect(access.cognito.calls).toHaveLength(calls);
  });

  it("[FL-132] a failing Cognito leaves FAILED and the metric; no lead in any branch", async () => {
    access.cognito.signUp = () => Promise.reject(Object.assign(new Error("throttled"), { name: "TooManyRequestsException" }));
    const { signupId } = await startSignup(access, { email: EMAIL }, "ip-a", log());
    expect(await stored(signupId)).toMatchObject({ branch: "FAILED" });
    expect((await stored(signupId))?.passwordSealed).toBeUndefined();
    expect(metrics()).toContainEqual(expect.objectContaining({ metric: "SignupDispatchFailed" }));
    expect(leadsWritten()).toBe(0);
    expect(access.invoker.invoked.some((call) => call.target === "LeadNotice")).toBe(false);
  });

  it("refuses an event that is not a dispatch event", async () => {
    await expect(runDispatch(access, { kind: "WAITLIST", signupId: "x" }, log())).rejects.toThrow();
  });
});

describe("[FL-101] a resend whose START never ran is the sign-up's START", () => {
  const LATER = new Date(NOW.getTime() + 61_000);
  let at: Date;

  beforeEach(() => {
    at = NOW;
    access = testAccessDeps(stores, { now: () => at, mx: fakeMx(["sin-correo.example-fict.com"]) });
  });

  async function begin(overrides: Parameters<typeof validForm>[1] = {}): Promise<string> {
    const answer = await signupStart(access, SignupStartInput.parse(validForm(access, overrides)), { ipHash: "ip-a", log: log() });
    expect(answer.status).toBe("CODE_SENT");
    return answer.status === "CODE_SENT" ? answer.signupId : "";
  }

  async function resendLater(signupId: string): Promise<void> {
    at = LATER;
    expect(await signupResend(access, signupId, { ipHash: "ip-a", log: log() })).toMatchObject({ status: "CODE_SENT" });
  }

  it("a START still queued when the visitor resends is dropped as stale; the resend creates the user and sends the code", async () => {
    const signupId = await begin();
    await resendLater(signupId);
    const [startEvent, resendEvent] = access.invoker.invoked.map((call) => call.payload);
    expect(await runDispatch(access, startEvent, log())).toEqual({ outcome: "STALE" });
    expect(await runDispatch(access, resendEvent, log())).toEqual({ outcome: "DONE", branch: "NEW" });
    const signup = await stored(signupId);
    expect(signup).toMatchObject({ branch: "NEW", dispatchedSeq: 2, accountUsername: signup?.username });
    expect(signup?.passwordSealed).toBeUndefined();
    expect(cognitoWrites(access.cognito.calls)).toEqual(["signUp"]);
    expect(access.cognito.users.get(String(signup?.username))).toMatchObject({ status: "UNCONFIRMED", email: EMAIL, password: "Quince-Caballos-7" });
    expect(access.cognito.codes).toEqual([expect.objectContaining({ kind: "SIGNUP", username: signup?.username })]);
    expect(leadsWritten()).toBe(0);
  });

  it("a START whose invoke failed: the resend creates the user and sends the code", async () => {
    const invoke = access.invoker.invoke.bind(access.invoker);
    let failures = 1;
    access.invoker.invoke = async (target, payload) => {
      if (failures-- > 0) throw Object.assign(new Error("unavailable"), { name: "ServiceException" });
      await invoke(target, payload);
    };
    const signupId = await begin();
    expect(await stored(signupId)).toMatchObject({ branch: "FAILED" });
    expect(access.invoker.invoked).toHaveLength(0);
    await resendLater(signupId);
    await drainDispatch(access, log());
    const signup = await stored(signupId);
    expect(signup).toMatchObject({ branch: "NEW", dispatchedSeq: 2 });
    expect(signup?.passwordSealed).toBeUndefined();
    expect(access.cognito.codes).toEqual([expect.objectContaining({ kind: "SIGNUP", username: signup?.username })]);
  });

  it("keeps every suppression of START: a never-dispatched sign-up to a domain without MX stays SUPPRESSED", async () => {
    const signupId = await begin({ email: "ana@sin-correo.example-fict.com" });
    await resendLater(signupId);
    await drainDispatch(access, log());
    expect(await stored(signupId)).toMatchObject({ branch: "SUPPRESSED", dispatchedSeq: 2 });
    expect(access.cognito.calls).toEqual([]);
    expect(metrics()).toContainEqual(expect.objectContaining({ metric: "SignupRejected", reason: "NO_MX" }));
  });

  it("a resend after a START that ran only resends the code, never signs up again", async () => {
    const signupId = await begin();
    await drainDispatch(access, log());
    await resendLater(signupId);
    await drainDispatch(access, log());
    expect(cognitoWrites(access.cognito.calls)).toEqual(["signUp", "resendCode"]);
    expect(await stored(signupId)).toMatchObject({ branch: "NEW", dispatchedSeq: 2 });
  });
});
