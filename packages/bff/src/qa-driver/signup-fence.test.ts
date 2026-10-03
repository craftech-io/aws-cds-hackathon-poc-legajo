// The fence of SC-26's actions (docs/test-plan.md §4.1): the only access of the `QaDriver` to `Leads`,
// the pool and the simulated mailboxes' raw MIME is a `qa-signup-<runId>-<key>` mailbox the driver
// builds from its own key's run; no input carries an email, a mailbox of another run or of a person is
// FORBIDDEN before any read, `lead.inspect` answers no personal data and `lead.purge` is leads:delete.
import { beforeEach, describe, expect, it } from "vitest";
import { SIM_MAIL_DOMAIN } from "@legajo/shared";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { leadEmailHash } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { signupConfirm } from "../signup/service";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { startSignup } from "../signup/testing-flows";
import { ACTION_INPUTS } from "./contract-inputs";
import type { ActionContext } from "./ports";
import { type AccountMailReader, type SignupActionDeps, signupActions } from "./signup-actions";
import { assertSignupMailbox, isSignupMailbox, runOfKey, signupMailbox } from "./signup-fence";

const KEY = "812-1/sc26/3/r1";
const MAILBOX = `qa-signup-812-1-a@${SIM_MAIL_DOMAIN}`;
const NOW = new Date("2026-10-14T13:30:00.000Z");
const log = createLogger({ level: "error" });

function rawMail(to: string, subject: string, body: string): Uint8Array {
  return new TextEncoder().encode([`From: avisos@legajo.demo.craftech.io`, `To: ${to}`, `Subject: ${subject}`, "Message-ID: <a1@legajo.demo.craftech.io>", "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n"));
}

function mailbox(objects: ReadonlyArray<{ key: string; at: Date; raw: Uint8Array }>): AccountMailReader & { readonly reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    listSince: (since) => Promise.resolve(objects.filter((object) => object.at >= since).map(({ key, at }) => ({ key, at }))),
    read: (key) => {
      reads.push(key);
      return Promise.resolve(objects.find((object) => object.key === key)?.raw ?? new Uint8Array());
    },
  };
}

function context(idempotencyKey: string = KEY): ActionContext {
  let at = NOW.getTime();
  return {
    idempotencyKey,
    scope: { name: "signup.readCode", firmId: "firm-qa", operations: [] },
    data: undefined as never,
    now: () => new Date(at),
    sleep: (ms) => Promise.resolve(void (at += ms)),
    log,
  };
}

describe("the sign-up mailbox fence of SC-26", () => {
  it("builds the mailbox from the call's own run and a key, never from an email", () => {
    expect(signupMailbox(KEY, "a")).toBe(MAILBOX);
    expect(signupMailbox("local-01j9zq0000000000000000000a/sc26/1/m1", "b")).toBe(`qa-signup-local-01j9zq0000000000000000000a-b@${SIM_MAIL_DOMAIN}`);
    expect(runOfKey(KEY)).toBe("812-1");
    for (const key of ["A", "a@b", "a.b", "ana.gomez", "", "a-b"]) expect(() => signupMailbox(KEY, key), key).toThrow();
    for (const action of ["signup.readCode", "lead.inspect", "lead.purge"] as const) {
      expect(ACTION_INPUTS[action].safeParse({ key: "a", kind: "SIGNUP", afterTs: NOW.toISOString(), email: "ana.gomez@despachos-del-sur.com.ar" }).success, action).toBe(false);
      expect(ACTION_INPUTS[action].safeParse({ key: "ana.gomez@despachos-del-sur.com.ar", kind: "SIGNUP", afterTs: NOW.toISOString() }).success, action).toBe(false);
    }
  });

  it("refuses any other address before a read: a person's, another domain, a subdomain, another run", () => {
    expect(isSignupMailbox(MAILBOX)).toBe(true);
    for (const address of ["ana.gomez@despachos-del-sur.com.ar", "qa-signup-812-1-a@sim.legajo.demo.craftech.io.evil.com", "qa-signup-812-1-a@x.sim.legajo.demo.craftech.io", "qa-812-1-sc01-a-elb@sim.legajo.demo.craftech.io", "qa-signup-812-1-a@sim.legajo.demo.craftech.io@x", "QA-SIGNUP-812-1-A@sim.legajo.demo.craftech.io"]) {
      expect(isSignupMailbox(address), address).toBe(false);
      expect(() => assertSignupMailbox(address, KEY), address).toThrow(expect.objectContaining({ code: "FORBIDDEN", reason: "QA_FENCE" }));
    }
    expect(() => assertSignupMailbox("qa-signup-813-1-a@sim.legajo.demo.craftech.io", KEY)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => assertSignupMailbox(MAILBOX, KEY)).not.toThrow();
  });
});

describe("SC-26's actions over the stores of the sign-up", () => {
  let stores: MemoryStores;
  let access: TestAccess;
  const deps = (mail: AccountMailReader): SignupActionDeps => ({ ...access, mail, leadEmailKey: access.keys.leadEmail });

  beforeEach(async () => {
    stores = memoryStores();
    access = testAccessDeps(stores, { now: () => NOW });
    const { signupId } = await startSignup(access, { email: MAILBOX, name: "Ana Gómez", company: "Despachos del Sur", utm: { source: "qa", campaign: "sc26" } });
    const username = (await access.signups.get(signupId, NOW))?.accountUsername ?? "";
    await signupConfirm(access, { signupId, code: access.cognito.lastCode(username) ?? "", password: "Quince-Caballos-7" }, { ipHash: "ip-a", log });
  });

  it("[FL-101] reads the code of the first mail to exactly that mailbox after afterTs, with its language and word check, never the MIME", async () => {
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
    const mail = mailbox([
      { key: "poc/sim/old", at: at(-5), raw: rawMail(MAILBOX, "Código de verificación", "Hola, tu código es 111111 y vence en una hora.") },
      { key: "poc/sim/other", at: at(1), raw: rawMail(`qa-signup-812-1-b@${SIM_MAIL_DOMAIN}`, "Código de verificación", "Hola, tu código es 222222 y vence en una hora.") },
      { key: "poc/sim/two", at: at(2), raw: rawMail(`${MAILBOX}, qa-signup-812-1-b@${SIM_MAIL_DOMAIN}`, "Código", "Tu código es 333333.") },
      { key: "poc/sim/ours", at: at(3), raw: rawMail(MAILBOX, "Tu código de verificación", "Hola, tu código para la cuenta es 444444. Si no pediste esta cuenta, ignorá este correo.") },
    ]);
    const read = await signupActions(() => deps(mail))["signup.readCode"]({ key: "a", kind: "SIGNUP", afterTs: NOW.toISOString(), timeoutSec: 30 }, context());
    expect(read).toMatchObject({ kind: "SIGNUP", code: "444444", subject: "Tu código de verificación", language: "es", neutral: { clean: true, groups: [] } });
    expect(Object.keys(read).sort()).toEqual(["code", "kind", "language", "neutral", "receivedAt", "subject"]);
    expect(mail.reads).not.toContain("poc/sim/old");
  });

  it("[FL-101] answers NO_ACCOUNT_MAIL when no mail for the mailbox arrives in time", async () => {
    const answer = signupActions(() => deps(mailbox([])))["signup.readCode"]({ key: "a", kind: "FORGOT", afterTs: NOW.toISOString(), timeoutSec: 10 }, context());
    await expect(answer).rejects.toMatchObject({ code: "UNAVAILABLE", reason: "NO_ACCOUNT_MAIL" });
  });

  it("[FL-115] inspects the lead with no personal data: consents, language, UTM, dates, counts and which optional fields exist", async () => {
    const inspected = await signupActions(() => deps(mailbox([])))["lead.inspect"]({ key: "a" }, context());
    expect(inspected).toMatchObject({ exists: true, leads: 1, users: 1, language: "es", utm: { source: "qa", campaign: "sc26" }, consents: { terms: { accepted: true }, contact: { accepted: true } }, optionalFields: ["name", "company"] });
    const text = JSON.stringify(inspected);
    for (const personal of [MAILBOX, "Ana", "Despachos", "usr-"]) expect(text, personal).not.toContain(personal);
    expect(await signupActions(() => deps(mailbox([])))["lead.inspect"]({ key: "b" }, context())).toMatchObject({ exists: false, leads: 0, users: 0 });
  });

  it("[FL-118] purges with the module of leads:delete: no lead, no account, a tombstone, and only that mailbox", async () => {
    const other = "ana.gomez@despachos-del-sur.com.ar";
    await startSignup(access, { email: other });
    const purged = await signupActions(() => deps(mailbox([])))["lead.purge"]({ key: "a" }, context("812-1/sc26/13/m1"));
    expect(purged).toMatchObject({ purged: true, users: 1 });
    expect(await access.leads.get(leadEmailHash(access.keys.leadEmail, MAILBOX))).toBeUndefined();
    expect(await access.cognito.findByEmail(MAILBOX)).toEqual([]);
    expect(await access.cognito.findByEmail(other)).toHaveLength(1);
    expect(await signupActions(() => deps(mailbox([])))["lead.purge"]({ key: "a" }, context("812-1/sc26/999/m1"))).toMatchObject({ purged: false, users: 0 });
  });
});
