// GUEST_SWEEP, the sign-up and lead part (ADR-0015 §5, FL-104 d, FL-122), on an injected real clock:
// unconfirmed users without groups past 24 h, verified sign-ups finalized (never an EXISTING_GUEST
// without the code), pending notices queued again, and the daily retention of 24 months; and the world
// part (FL-109): public worlds past their TTL destroyed and their slots freed, reserved ones kept.
import { beforeEach, describe, expect, it } from "vitest";
import { LEAD_RETENTION_DAYS, UNCONFIRMED_USER_MAX_AGE_HOURS } from "@legajo/shared/guest-limits";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { leadEmailHash } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { LEADS_TABLE, tombKey } from "../leads/lead";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { startSignup } from "../signup/testing-flows";
import { createWorld } from "../worlds/factory";
import { slotKey } from "../worlds/guest-slots";
import { worldsHarness } from "../worlds/testing";
import { NOTICE_RETRY_GRACE_MS, RETENTION_HOUR_UTC, sweepGuestWorlds, sweepSignupsAndLeads } from "./guest-sweep";

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

const hours = (count: number) => (now = new Date(now.getTime() + count * 3_600_000));
const leadOf = (email: string) => access.leads.get(leadEmailHash(access.keys.leadEmail, email));

describe("[FL-122] the hourly sweep of sign-ups and leads", () => {
  it("deletes UNCONFIRMED users without groups older than 24 h, and nobody else", async () => {
    access.cognito.seed({ username: "usr-old", email: "old@despachos-del-sur.com.ar", status: "UNCONFIRMED", createdAt: new Date(now.getTime() - (UNCONFIRMED_USER_MAX_AGE_HOURS + 1) * 3_600_000) });
    access.cognito.seed({ username: "usr-recent", email: "recent@despachos-del-sur.com.ar", status: "UNCONFIRMED", createdAt: new Date(now.getTime() - 3_600_000) });
    access.cognito.seed({ username: "usr-old-grouped", email: "grouped@despachos-del-sur.com.ar", status: "UNCONFIRMED", groups: ["GUEST"], createdAt: new Date(0) });
    access.cognito.seed({ username: "brk-old", email: "staff@despachos-del-sur.com.ar", status: "CONFIRMED", groups: ["BROKER"], createdAt: new Date(0) });
    expect((await sweepSignupsAndLeads(access, log)).unconfirmedDeleted).toBe(1);
    expect([...access.cognito.users.keys()].sort()).toEqual(["brk-old", "usr-old-grouped", "usr-recent"]);
  });

  it("finalizes a sign-up whose own user was confirmed without coming back (a direct ConfirmSignUp)", async () => {
    const { signupId } = await startSignup(access, { email: EMAIL });
    const username = (await access.signups.get(signupId, now))?.username ?? "";
    const user = access.cognito.users.get(username);
    if (user !== undefined) {
      user.status = "CONFIRMED";
      user.createdAt = new Date(now.getTime() + 1_000);
    }
    hours(1);
    expect((await sweepSignupsAndLeads(access, log)).finalized).toBe(1);
    expect(await leadOf(EMAIL)).toBeDefined();
    expect(access.cognito.users.get(username)?.groups).toEqual(["GUEST"]);
  });

  it("[FL-104] never finalizes an EXISTING_GUEST sign-up without the code (case d)", async () => {
    access.cognito.seed({ username: "usr-guest", email: EMAIL, groups: ["GUEST"] });
    const { signupId } = await startSignup(access, { email: EMAIL });
    expect(await access.signups.get(signupId, now)).toMatchObject({ branch: "EXISTING_GUEST" });
    hours(1);
    expect((await sweepSignupsAndLeads(access, log)).finalized).toBe(0);
    expect(await leadOf(EMAIL)).toBeUndefined();
    expect(access.invoker.invoked.some((call) => call.target === "LeadNotice")).toBe(false);
  });

  it("queues again the notices still PENDING after their grace period", async () => {
    const consent = { at: now.toISOString(), lang: "es" as const, version: "2026-10-02" };
    await access.leads.saveVerifiedLead({ newLeadId: "01J9ZQ00000000000000000003", email: EMAIL, emailHash: leadEmailHash(access.keys.leadEmail, EMAIL), consents: { terms: { accepted: true, privacyVersion: "2026-10-02", ...consent }, contact: { accepted: true, ...consent } }, language: "es", utm: {}, signupAt: consent.at, confirmedAt: consent.at, cognitoUsername: "usr-x" }, now);
    expect((await sweepSignupsAndLeads(access, log)).noticesQueued).toBe(0);
    now = new Date(now.getTime() + NOTICE_RETRY_GRACE_MS + 1);
    expect((await sweepSignupsAndLeads(access, log)).noticesQueued).toBe(1);
    await access.leads.setNotice(leadEmailHash(access.keys.leadEmail, EMAIL), "SENT", 1, now);
    expect((await sweepSignupsAndLeads(access, log)).noticesQueued).toBe(0);
  });

  it("once a day, retires leads without a sign-in for 24 months with a RETENTION tombstone", async () => {
    const old = new Date(now.getTime() - (LEAD_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    const consent = { at: old, lang: "es" as const, version: "2026-10-02" };
    const lead = (email: string, leadId: string, signupAt: string) => ({ newLeadId: leadId, email, emailHash: leadEmailHash(access.keys.leadEmail, email), consents: { terms: { accepted: true, privacyVersion: "2026-10-02", ...consent }, contact: { accepted: true, ...consent } }, language: "es" as const, utm: {}, signupAt, confirmedAt: signupAt, cognitoUsername: "usr-x" });
    await access.leads.saveVerifiedLead(lead("vieja@despachos-del-sur.com.ar", "01J9ZQ00000000000000000004", old), now);
    await access.leads.saveVerifiedLead(lead("activa@despachos-del-sur.com.ar", "01J9ZQ00000000000000000005", old), now);
    await access.leads.touchLastLogin(leadEmailHash(access.keys.leadEmail, "activa@despachos-del-sur.com.ar"), now.toISOString(), now);
    expect((await sweepSignupsAndLeads(access, log)).leadsRetired).toBe(0);
    now = new Date(`${now.toISOString().slice(0, 10)}T${String(RETENTION_HOUR_UTC).padStart(2, "0")}:05:00.000Z`);
    now = new Date(now.getTime() + 86_400_000);
    expect((await sweepSignupsAndLeads(access, log)).leadsRetired).toBe(1);
    expect(await leadOf("vieja@despachos-del-sur.com.ar")).toBeUndefined();
    expect(await leadOf("activa@despachos-del-sur.com.ar")).toBeDefined();
    expect(await stores.client.get(LEADS_TABLE, tombKey("01J9ZQ00000000000000000004"))).toMatchObject({ reason: "RETENTION" });
  });

  it("[FL-109] destroys public worlds idle for 24 h or 72 h old and frees their slots; reserved worlds stay", async () => {
    const h = worldsHarness({ stores, realNow: now.toISOString() });
    for (const firmId of ["firm-guest-31", "firm-guest-32", "firm-guest-04"]) {
      const nn = Number(firmId.slice(-2));
      await stores.client.put("Runtime", { ...slotKey(nn), entity: "GuestSlot", version: 1, nn, sub: `sub-${nn}`, firmId, clockId: `GUEST#${firmId}`, leaseId: `lease-${nn}`, leasedAtReal: now.toISOString(), hardExpiresAtReal: new Date(now.getTime() + 72 * 3_600_000).toISOString() });
      await createWorld({ kind: "GUEST", firmId }, h.deps);
    }
    const busy = await stores.connector.world.getClock("GUEST#firm-guest-32");
    h.realNow = new Date(now.getTime() + 25 * 3_600_000);
    await stores.connector.world.updateClock(busy.clockId, { lastSession: { originJti: "jti-32", authTime: 1, lastActiveAtReal: h.realNow.toISOString() } } as never, busy.version);
    expect(await sweepGuestWorlds(h.deps)).toEqual({ creationsFailed: 0, worldsDestroyed: 1 });
    expect(await stores.connector.world.findClock("GUEST#firm-guest-31")).toBeUndefined();
    expect(await stores.connector.world.findClock("GUEST#firm-guest-32")).toBeDefined();
    expect(await stores.connector.world.findClock("GUEST#firm-guest-04")).toBeDefined();
    h.realNow = new Date(now.getTime() + 72 * 3_600_000);
    expect(await sweepGuestWorlds(h.deps)).toMatchObject({ worldsDestroyed: 1 });
    expect(await stores.connector.world.findClock("GUEST#firm-guest-32")).toBeUndefined();
  });
});
