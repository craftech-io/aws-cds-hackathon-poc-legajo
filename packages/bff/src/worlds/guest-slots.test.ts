// The leases of a guest world (ADR-0015 §4): one account takes one lease however many calls race, a
// public slot is free or released at least 20 minutes ago, the 60 public slots can fill up, and a
// stale creation is taken over; `ensureWorld` over both leases queues one `GUEST_CREATE` per account.
import { describe, expect, it } from "vitest";
import { GUEST_SLOTS, GUEST_WORLD_CREATING_STALE_MINUTES, SLOT_RELEASE_COOLDOWN_MINUTES } from "@legajo/shared/guest-limits";
import { sequentialIds } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { type EnsureDeps, ensureGuestWorld } from "./guest-worlds";
import { type WorldsHarness, worldsHarness } from "./testing";
import { guestFirmOf, isPublicGuestFirm, leaseAccountWorld, leasePublicSlot, markAccountWorld, readAccountWorld, releaseSlot, slotOfFirm, worldStateOf } from "./guest-slots";

const NOW = new Date("2026-10-14T13:30:00.000Z");
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);
const PUBLIC_COUNT = GUEST_SLOTS.public.last - GUEST_SLOTS.public.first + 1;

describe("[FL-105] the account's lease (GUESTWORLD#<sub>)", () => {
  it("30 calls at once with the same sub: exactly one wins, the rest read CREATING", async () => {
    const { client } = memoryStores();
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => leaseAccountWorld(client, "sub-a", `lease-${index}`, NOW)));
    const winners = results.filter((result) => result.won);
    expect(winners).toHaveLength(1);
    for (const result of results.filter((entry) => !entry.won)) expect(result.won === false && result.current?.state).toBe("CREATING");
    expect((await readAccountWorld(client, "sub-a"))?.leaseId).toBe(winners[0]?.won === true ? winners[0].lease.leaseId : "");
  });

  it("a READY or fresh CREATING lease is kept; a stale CREATING, FAILED or DESTROYED one is taken again", async () => {
    const { client } = memoryStores();
    await leaseAccountWorld(client, "sub-a", "lease-1", NOW);
    expect((await leaseAccountWorld(client, "sub-a", "lease-2", minutes(GUEST_WORLD_CREATING_STALE_MINUTES))).won).toBe(false);
    expect((await leaseAccountWorld(client, "sub-a", "lease-3", minutes(GUEST_WORLD_CREATING_STALE_MINUTES + 1))).won).toBe(true);
    expect(await markAccountWorld(client, "sub-a", "lease-1", { state: "READY" }, NOW)).toBe(false);
    expect(await markAccountWorld(client, "sub-a", "lease-3", { state: "READY", nn: 41, firmId: "firm-guest-41" }, NOW)).toBe(true);
    expect((await leaseAccountWorld(client, "sub-a", "lease-4", minutes(60))).won).toBe(false);
    await markAccountWorld(client, "sub-a", "lease-3", { state: "DESTROYED" }, minutes(60));
    expect((await leaseAccountWorld(client, "sub-a", "lease-5", minutes(61))).won).toBe(true);
  });

  it("maps a lease to the states account.world knows", () => {
    const at = NOW.toISOString();
    expect(worldStateOf(undefined)).toBe("NONE");
    expect(worldStateOf({ state: "CREATING" })).toBe("CREATING");
    expect(worldStateOf({ state: "READY", reason: undefined })).toBe("READY");
    expect(worldStateOf({ state: "DESTROYED" })).toBe("EXPIRED");
    expect(worldStateOf({ state: "FAILED", reason: "CAPACITY" })).toBe("CAPACITY");
    expect(worldStateOf({ state: "FAILED", reason: "SEED_UNAVAILABLE" })).toBe("FAILED");
    expect(at).toBeTruthy();
  });
});

describe("[FL-110] public slots (31–90)", () => {
  it("leases each of the 60 slots once, then answers capacity; never a reserved one", async () => {
    const { client } = memoryStores();
    const leased = new Set<number>();
    for (let index = 0; index < PUBLIC_COUNT; index += 1) {
      const slot = await leasePublicSlot(client, { sub: `sub-${index}`, leaseId: `lease-${index}`, now: NOW, random: () => 0.5 });
      expect(slot).toBeDefined();
      leased.add(slot?.nn ?? 0);
    }
    expect(leased.size).toBe(PUBLIC_COUNT);
    expect(Math.min(...leased)).toBe(GUEST_SLOTS.public.first);
    expect(Math.max(...leased)).toBe(GUEST_SLOTS.public.last);
    expect(await leasePublicSlot(client, { sub: "sub-late", leaseId: "lease-late", now: NOW })).toBeUndefined();
  });

  it("starts from a random slot and names its firm and clock", async () => {
    const { client } = memoryStores();
    const slot = await leasePublicSlot(client, { sub: "sub-a", leaseId: "lease-a", now: NOW, random: () => 0.999 });
    expect(slot).toMatchObject({ nn: GUEST_SLOTS.public.last, firmId: guestFirmOf(GUEST_SLOTS.public.last), clockId: `GUEST#${guestFirmOf(GUEST_SLOTS.public.last)}`, leaseId: "lease-a", sub: "sub-a" });
  });
});

describe("[FL-109] a released slot", () => {
  it("is not leased again before 20 minutes, and only its own lease releases it", async () => {
    const { client } = memoryStores();
    for (let index = 0; index < PUBLIC_COUNT; index += 1) await leasePublicSlot(client, { sub: `sub-${index}`, leaseId: `lease-${index}`, now: NOW, random: () => 0 });
    const nn = GUEST_SLOTS.public.first;
    expect(await releaseSlot(client, nn, "someone-else", NOW)).toBe(false);
    expect(await releaseSlot(client, nn, "lease-0", NOW)).toBe(true);
    expect(await releaseSlot(client, nn, "lease-0", NOW)).toBe(false);
    expect(await leasePublicSlot(client, { sub: "sub-new", leaseId: "lease-new", now: minutes(SLOT_RELEASE_COOLDOWN_MINUTES - 1) })).toBeUndefined();
    expect(await leasePublicSlot(client, { sub: "sub-new", leaseId: "lease-new", now: minutes(SLOT_RELEASE_COOLDOWN_MINUTES) })).toMatchObject({ nn, sub: "sub-new" });
  });

  it("public and reserved firms are told apart by their slot", () => {
    expect(isPublicGuestFirm(guestFirmOf(GUEST_SLOTS.public.first))).toBe(true);
    expect(isPublicGuestFirm(guestFirmOf(GUEST_SLOTS.reserved.last))).toBe(false);
    expect(isPublicGuestFirm("firm-guest-test")).toBe(false);
    expect(slotOfFirm("firm-guest-07")).toBe(7);
    expect(slotOfFirm("firm-delta")).toBeUndefined();
  });
});

describe("[FL-105] account.ensureWorld over both leases", () => {
  const deps = (h: WorldsHarness, invoked: Array<{ target: string; payload: unknown }>): EnsureDeps => ({
    client: h.stores.client,
    cognito: { getUser: async () => undefined },
    invoker: { invoke: async (target, payload) => void invoked.push({ target, payload }) },
    now: () => h.realNow,
    newUlid: sequentialIds("LEASE"),
    log: h.deps.log,
  });

  it("30 ensureWorld at once with the same sub: one slot and one GUEST_CREATE", async () => {
    const h = worldsHarness();
    const invoked: Array<{ target: string; payload: unknown }> = [];
    const shared = deps(h, invoked);
    const answers = await Promise.allSettled(Array.from({ length: 30 }, () => ensureGuestWorld({ sub: "sub-a", username: "usr-a" }, shared)));
    // Past 10 calls an hour the account gets QUOTA_EXCEEDED; every other call answers CREATING.
    for (const answer of answers) {
      if (answer.status === "fulfilled") expect(answer.value.state).toBe("CREATING");
      else expect(answer.reason).toMatchObject({ kind: "WORLD_PREPARATIONS" });
    }
    expect(invoked.filter((call) => call.target === "WorldJanitor")).toHaveLength(1);
    const leased = h.stores.client.dump("Runtime").filter((row) => String(row.PK).startsWith("SLOT#GUEST#"));
    expect(leased).toHaveLength(1);
  });

  it("a CREATING lease older than 5 minutes is taken again with a new lease", async () => {
    const h = worldsHarness();
    const invoked: Array<{ target: string; payload: unknown }> = [];
    const shared = deps(h, invoked);
    await ensureGuestWorld({ sub: "sub-a", username: "usr-a" }, shared);
    const first = await readAccountWorld(h.stores.client, "sub-a");
    h.realNow = new Date(h.realNow.getTime() + (GUEST_WORLD_CREATING_STALE_MINUTES + 1) * 60_000);
    await ensureGuestWorld({ sub: "sub-a", username: "usr-a" }, shared);
    const second = await readAccountWorld(h.stores.client, "sub-a");
    expect(second?.leaseId).not.toBe(first?.leaseId);
    expect(invoked.filter((call) => call.target === "WorldJanitor")).toHaveLength(2);
  });
});
