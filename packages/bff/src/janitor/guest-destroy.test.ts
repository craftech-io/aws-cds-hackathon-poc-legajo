// The entries of `WorldJanitor` (ADR-0015 §5, FL-105, FL-109, FL-118, FL-122): `GUEST_CREATE`,
// `GUEST_SWEEP` (with the lead retention destroying a leased world in process, never by invoking itself),
// `GUEST_DESTROY` and `IDLE_GUEST_RESET`, each validated with zod first; and the Memory purges a world
// event starts, run at the end of the same invocation.
import { beforeEach, describe, expect, it } from "vitest";
import { LEAD_RETENTION_DAYS } from "@legajo/shared/guest-limits";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { createWorldJanitorHandler } from "../handlers/world-janitor";
import { leadEmailHash } from "../lib/crypto";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { leaseAccountWorld, leasePublicSlot, markAccountWorld, readAccountWorld, readSlot } from "../worlds/guest-slots";
import type { PurgeDeps } from "../worlds/memory-purge";
import { type WorldsHarness, worldsHarness } from "../worlds/testing";
import { GuestDestroyEvent, isIdleForReset, reservedGuestFirms } from "./guest-destroy";
import { RETENTION_HOUR_UTC } from "./guest-sweep";

const NOW = "2026-10-14T13:30:00.000Z";
let stores: MemoryStores;
let access: TestAccess;
let h: WorldsHarness;

beforeEach(() => {
  stores = memoryStores();
  h = worldsHarness({ stores, realNow: NOW });
  access = testAccessDeps(stores, { now: () => h.realNow });
});

function janitor() {
  const purge: PurgeDeps = { memory: h.memory, data: stores.connector, log: h.deps.log, now: () => h.realNow, sleep: async (ms) => void (h.realNow = new Date(h.realNow.getTime() + ms)) };
  return createWorldJanitorHandler({ purge, worlds: (continuePurge) => ({ ...h.deps, continuePurge }), sweep: () => access });
}

async function leasedPublicWorld(sub: string): Promise<{ readonly leaseId: string; readonly nn: number }> {
  const leaseId = `lease-${sub}`;
  await leaseAccountWorld(stores.client, sub, leaseId, h.realNow);
  const slot = await leasePublicSlot(stores.client, { sub, leaseId, now: h.realNow, random: () => 0 });
  await markAccountWorld(stores.client, sub, leaseId, { state: "CREATING", firmId: slot?.firmId ?? "", nn: slot?.nn ?? 0 }, h.realNow);
  return { leaseId, nn: slot?.nn ?? 0 };
}

describe("[FL-105] WorldJanitor events", () => {
  it("refuses an event it does not know or with extra fields, before doing anything", async () => {
    await expect(janitor()({ kind: "RESET_EVERYTHING" })).rejects.toThrow();
    await expect(janitor()({ kind: "GUEST_DESTROY", firmId: "firm-delta", reason: "REQUEST" })).rejects.toThrow();
    await expect(janitor()({ kind: "IDLE_GUEST_RESET", extra: true })).rejects.toThrow();
    expect(GuestDestroyEvent.safeParse({ kind: "GUEST_DESTROY", firmId: "firm-guest-41", reason: "REQUEST", sub: "s" }).success).toBe(true);
  });

  it("GUEST_CREATE creates the world and readies the lease; a stale lease id does nothing", async () => {
    const { leaseId, nn } = await leasedPublicWorld("sub-a");
    expect(await janitor()({ kind: "GUEST_CREATE", sub: "sub-a", leaseId: "lease-old", firmId: "firm-guest-31", nn })).toMatchObject({ outcome: "STALE" });
    expect(await janitor()({ kind: "GUEST_CREATE", sub: "sub-a", leaseId, firmId: "firm-guest-31", nn })).toMatchObject({ outcome: "READY" });
    expect(await readAccountWorld(stores.client, "sub-a")).toMatchObject({ state: "READY", firmId: "firm-guest-31" });
  });

  it("[FL-118] GUEST_DESTROY destroys the world, marks the lease DESTROYED, frees the slot and purges Memory in the same run", async () => {
    const { leaseId, nn } = await leasedPublicWorld("sub-a");
    await janitor()({ kind: "GUEST_CREATE", sub: "sub-a", leaseId, firmId: "firm-guest-31", nn });
    h.memory.records.set("/importers/imp-norpampa-g31-e1/facts/", ["rec-1"]);
    const result = await janitor()({ kind: "GUEST_DESTROY", firmId: "firm-guest-31", reason: "REQUEST", sub: "sub-a" });
    expect(result).toMatchObject({ destroyed: true, purges: 1, purgesIncomplete: 0 });
    expect(await readAccountWorld(stores.client, "sub-a")).toMatchObject({ state: "DESTROYED" });
    expect((await readSlot(stores.client, 31))?.releasedAtReal).toBeDefined();
    expect(h.memory.remaining()).toBe(0);
  });

  it("[FL-122] GUEST_SWEEP: the lead retention destroys a leased world in process and the slot is freed", async () => {
    const email = "vieja@despachos-del-sur.com.ar";
    const { leaseId, nn } = await leasedPublicWorld("sub-old");
    await janitor()({ kind: "GUEST_CREATE", sub: "sub-old", leaseId, firmId: "firm-guest-31", nn });
    access.cognito.seed({ username: "usr-old", email, sub: "sub-old", status: "CONFIRMED", groups: ["GUEST"] } as never);
    const old = new Date(Date.parse(NOW) - (LEAD_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    const consent = { at: old, lang: "es" as const, version: "2026-10-02" };
    await access.leads.saveVerifiedLead({ newLeadId: "01J9ZQ00000000000000000009", email, emailHash: leadEmailHash(access.keys.leadEmail, email), consents: { terms: { accepted: true, privacyVersion: "2026-10-02", ...consent }, contact: { accepted: true, ...consent } }, language: "es", utm: {}, signupAt: old, confirmedAt: old, cognitoUsername: "usr-old" }, h.realNow);
    h.realNow = new Date(`2026-10-15T${String(RETENTION_HOUR_UTC).padStart(2, "0")}:05:00.000Z`);
    const result = await janitor()({ kind: "GUEST_SWEEP" });
    expect(result).toMatchObject({ leadsRetired: 1 });
    expect(access.invoker.invoked.filter((entry) => entry.target === "WorldJanitor")).toEqual([]);
    expect(await stores.connector.world.findClock("GUEST#firm-guest-31")).toBeUndefined();
    expect((await readSlot(stores.client, 31))?.releasedAtReal).toBeDefined();
  });

  it("[FL-109] IDLE_GUEST_RESET resets reserved worlds idle for 24 h, never a public one", async () => {
    const { leaseId, nn } = await leasedPublicWorld("sub-p");
    await janitor()({ kind: "GUEST_CREATE", sub: "sub-p", leaseId, firmId: "firm-guest-31", nn });
    await leaseAccountWorld(stores.client, "sub-r", "lease-r", h.realNow);
    await markAccountWorld(stores.client, "sub-r", "lease-r", { state: "CREATING", firmId: "firm-guest-02", nn: 2 }, h.realNow);
    await stores.client.put("Runtime", { PK: "SLOT#GUEST#02", SK: "META", entity: "GuestSlot", version: 1, nn: 2, sub: "sub-r", firmId: "firm-guest-02", clockId: "GUEST#firm-guest-02", leaseId: "lease-r", leasedAtReal: NOW, hardExpiresAtReal: "9999-12-31T23:59:59.000Z" });
    await janitor()({ kind: "GUEST_CREATE", sub: "sub-r", leaseId: "lease-r", firmId: "firm-guest-02", nn: 2 });
    h.realNow = new Date(Date.parse(NOW) + 25 * 3_600_000);
    expect(await janitor()({ kind: "IDLE_GUEST_RESET" })).toMatchObject({ reset: 1, failed: 0 });
    expect((await stores.connector.world.getClock("GUEST#firm-guest-02")).worldEpoch).toBe(2);
    expect((await stores.connector.world.getClock("GUEST#firm-guest-31")).worldEpoch).toBe(1);
  });

  it("knows which worlds are reserved and when one is idle", () => {
    expect(reservedGuestFirms()).toHaveLength(31);
    expect(reservedGuestFirms()).toContain("firm-guest-test");
    const clock = { createdAt: NOW, lastSession: { originJti: "j", authTime: 1, lastActiveAtReal: NOW } };
    expect(isIdleForReset(clock, new Date(Date.parse(NOW) + 23 * 3_600_000))).toBe(false);
    expect(isIdleForReset(clock, new Date(Date.parse(NOW) + 24 * 3_600_000))).toBe(true);
    expect(isIdleForReset({ ...clock, lastResetAtReal: new Date(Date.parse(NOW) + 3_600_000).toISOString() }, new Date(Date.parse(NOW) + 48 * 3_600_000))).toBe(false);
  });
});
