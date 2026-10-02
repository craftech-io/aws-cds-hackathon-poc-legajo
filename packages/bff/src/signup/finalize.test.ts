// finalizeSignup (ADR-0015 §1, §1.3 and §1.4): the only place a lead is born, only with the proof that
// the mailbox's owner used the code; the GUEST group only on a user without groups; one notice per new
// lead; idempotent; blind to the capacity of guest worlds.
import { beforeEach, describe, expect, it } from "vitest";
import { GUEST_SLOTS } from "@legajo/shared/guest-limits";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { leadEmailHash } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { LEADS_TABLE, signupKey } from "../leads/lead";
import { leasePublicSlot } from "../worlds/guest-slots";
import { RUNTIME_TABLE } from "./counters";
import { finalizeSignup } from "./finalize";
import { signupConfirm } from "./service";
import { type TestAccess, testAccessDeps } from "./testing";
import { TEST_PASSWORD, startSignup } from "./testing-flows";

const log = createLogger({ level: "error" });
const EMAIL = "ana.gomez@despachos-del-sur.com.ar";
let now: Date;
let stores: MemoryStores;
let access: TestAccess;

beforeEach(() => {
  now = new Date("2026-10-14T13:30:00.000Z");
  stores = memoryStores();
  access = testAccessDeps(stores, { now: () => now });
});

const leadHash = (email: string) => leadEmailHash(access.keys.leadEmail, email);
const confirm = (signupId: string, code: string, password = TEST_PASSWORD) => signupConfirm(access, { signupId, code, password }, { ipHash: "ip-a", log });
const codeOf = async (signupId: string) => access.cognito.lastCode((await access.signups.get(signupId, now))?.accountUsername ?? "") ?? "";
const notices = () => access.invoker.invoked.filter((call) => call.target === "LeadNotice");

describe("[FL-101] a new email confirmed with its code", () => {
  it("writes the lead, adds GUEST to a user without groups, queues one notice and deletes the sign-up", async () => {
    const { signupId } = await startSignup(access, { email: EMAIL, name: "Ana Gómez (ficticia)", utm: { source: "linkedin", campaign: "otoño 2026" }, referrer: "https://www.search.example-fict.com/q" });
    const username = (await access.signups.get(signupId, now))?.username ?? "";
    now = new Date(now.getTime() + 60_000);
    expect(await confirm(signupId, await codeOf(signupId))).toEqual({ status: "CONFIRMED" });
    const lead = await access.leads.get(leadHash(EMAIL));
    expect(lead).toMatchObject({
      email: EMAIL,
      name: "Ana Gómez (ficticia)",
      sourcePoc: "legajo-listo",
      language: "es",
      utm: { source: "linkedin" },
      referrer: "https://www.search.example-fict.com",
      signupAt: "2026-10-14T13:30:00.000Z",
      confirmedAt: "2026-10-14T13:31:00.000Z",
      cognitoUsername: username,
      noticeStatus: "PENDING",
      consents: { terms: { accepted: true, version: access.legalVersions.terms, privacyVersion: access.legalVersions.privacy, lang: "es" }, contact: { accepted: true, version: access.legalVersions.contact, lang: "es" } },
    });
    expect(lead).not.toHaveProperty("status");
    expect(lead).not.toHaveProperty("emailVerified");
    expect(access.cognito.users.get(username)).toMatchObject({ status: "CONFIRMED", groups: ["GUEST"] });
    expect(notices()).toEqual([{ target: "LeadNotice", payload: { leadKey: leadHash(EMAIL) } }]);
    expect(await stores.client.get(LEADS_TABLE, signupKey(signupId))).toBeUndefined();
  });

  it("[FL-122] without the code, the sign-up's own user confirmed after its start is proof enough; one created before is not", async () => {
    const { signupId } = await startSignup(access, { email: EMAIL });
    const username = (await access.signups.get(signupId, now))?.username ?? "";
    const user = access.cognito.users.get(username);
    if (user === undefined) throw new Error("no user");
    user.status = "CONFIRMED";
    user.createdAt = new Date(now.getTime() - 1_000);
    expect(await finalizeSignup(access, signupId, log)).toBe("NO_PROOF");
    user.createdAt = new Date(now.getTime() + 1_000);
    expect(await finalizeSignup(access, signupId, log)).toBe("FINALIZED");
    expect(await access.leads.get(leadHash(EMAIL))).toBeDefined();
  });

  it("is idempotent: a second run finds nothing to do and sends no second notice", async () => {
    const { signupId } = await startSignup(access, { email: EMAIL });
    await confirm(signupId, await codeOf(signupId));
    expect(await finalizeSignup(access, signupId, log)).toBe("GONE");
    expect(notices()).toHaveLength(1);
  });

  it("never adds GUEST to a user that already has a group", async () => {
    const { signupId } = await startSignup(access, { email: EMAIL });
    const username = (await access.signups.get(signupId, now))?.username ?? "";
    access.cognito.users.get(username)?.groups.push("ANALYST");
    await confirm(signupId, await codeOf(signupId));
    expect(access.cognito.users.get(username)?.groups).toEqual(["ANALYST"]);
  });
});

describe("[FL-104] an email that already has a public guest account", () => {
  beforeEach(async () => {
    // The account and the lead of an earlier, verified sign-up (contact not accepted then).
    access.cognito.seed({ username: "usr-guest", email: EMAIL, groups: ["GUEST"], password: "Vieja-Contrasena-1" });
    const consent = { at: "2026-10-01T12:00:00.000Z", lang: "es" as const };
    await access.leads.saveVerifiedLead(
      {
        newLeadId: "01J9ZQ00000000000000000099",
        email: EMAIL,
        emailHash: leadHash(EMAIL),
        consents: { terms: { accepted: true, version: access.legalVersions.terms, privacyVersion: access.legalVersions.privacy, ...consent }, contact: { accepted: false, version: access.legalVersions.contact, ...consent } },
        language: "es",
        utm: {},
        signupAt: consent.at,
        confirmedAt: consent.at,
        cognitoUsername: "usr-guest",
      },
      now,
    );
  });

  it("without the code nothing is finalized: lead, consents, groups and password stay as they were (case d)", async () => {
    const before = await access.leads.get(leadHash(EMAIL));
    const { signupId } = await startSignup(access, { email: EMAIL, company: "Otra empresa (ficticia)", consents: { terms: true, contact: true } });
    expect(await access.signups.get(signupId, now)).toMatchObject({ branch: "EXISTING_GUEST" });
    expect(await finalizeSignup(access, signupId, log)).toBe("NO_PROOF");
    expect(await access.leads.get(leadHash(EMAIL))).toEqual(before);
    expect(access.cognito.users.get("usr-guest")).toMatchObject({ groups: ["GUEST"], password: "Vieja-Contrasena-1" });
    expect(notices()).toHaveLength(0);
  });

  it("with the code: the new password, the merged lead with the earlier consents in its history, no second notice", async () => {
    const { signupId } = await startSignup(access, { email: EMAIL, company: "Otra empresa (ficticia)", consents: { terms: true, contact: true } });
    now = new Date(now.getTime() + 120_000);
    expect(await confirm(signupId, await codeOf(signupId), "Nueva-Contrasena-9")).toEqual({ status: "CONFIRMED" });
    expect(access.cognito.users.get("usr-guest")).toMatchObject({ groups: ["GUEST"], password: "Nueva-Contrasena-9" });
    const lead = await access.leads.get(leadHash(EMAIL));
    expect(lead).toMatchObject({ company: "Otra empresa (ficticia)", consents: { contact: { accepted: true } }, cognitoUsername: "usr-guest" });
    expect(lead?.consentHistory).toContainEqual(expect.objectContaining({ consent: "contact", accepted: false }));
    expect(notices()).toHaveLength(0);
  });
});

describe("[FL-132] the lead does not depend on the capacity of guest worlds", () => {
  it("with every public slot leased, the confirmed sign-up still writes its lead and leases nothing", async () => {
    for (let nn = GUEST_SLOTS.public.first; nn <= GUEST_SLOTS.public.last; nn += 1) await leasePublicSlot(stores.client, { sub: `sub-${nn}`, leaseId: `lease-${nn}`, now, random: () => 0 });
    const leases = () => stores.client.dump(RUNTIME_TABLE).filter((row) => row.PK.startsWith("GUESTWORLD#") || row.PK.startsWith("SLOT#")).map((row) => `${row.PK}:${String(row.version)}`);
    const before = leases();
    const { signupId } = await startSignup(access, { email: EMAIL });
    expect(await confirm(signupId, await codeOf(signupId))).toEqual({ status: "CONFIRMED" });
    expect(await access.leads.get(leadHash(EMAIL))).toBeDefined();
    expect(leases()).toEqual(before);
    expect(notices()).toHaveLength(1);
  });
});
