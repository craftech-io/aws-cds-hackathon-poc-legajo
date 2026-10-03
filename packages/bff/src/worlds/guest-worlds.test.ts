// The life of a guest world (ADR-0015 §4 and §5, FL-105, FL-109, FL-110, FL-118, FL-132): the slot cap
// (CAPACITY), the TTL by inactivity and by age, the next sign-in creating the world again at a higher
// epoch, a released slot not leased again before 20 minutes, no S3 object of a destroyed world left in
// any bucket, and reserved worlds reset at night but never destroyed by the sweep.
import { describe, expect, it } from "vitest";
import { GUEST_SLOTS } from "@legajo/shared/guest-limits";
import { guestWorldPrefix } from "@legajo/shared/document-keys";
import { sweepGuestWorlds } from "../janitor/guest-sweep";
import { idleGuestReset } from "../janitor/guest-destroy";
import { sequentialIds } from "../connector/index";
import { brokerKey, operationPartition } from "../connector/keys";
import type { CognitoUser } from "../signup/cognito";
import type { AsyncInvoker } from "../signup/invoke";
import { type EnsureDeps, createGuestWorld, destroyGuestWorld, ensureGuestWorld } from "./guest-worlds";
import { readAccountWorld, readSlot, slotKey } from "./guest-slots";
import { MAIL_PREFIXES, type WorldsHarness, worldsHarness } from "./testing";

const HOUR = 3_600_000;
const TOKEN = "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7jKl0nPq3";

interface Invoked {
  readonly target: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function ensureDeps(h: WorldsHarness, invoked: Invoked[], users: Readonly<Record<string, Partial<CognitoUser>>> = {}, random?: () => number): EnsureDeps {
  const invoker: AsyncInvoker = { invoke: async (target, payload) => void invoked.push({ target, payload }) };
  return {
    client: h.stores.client,
    cognito: { getUser: async (username) => (users[username] === undefined ? undefined : ({ username, status: "CONFIRMED", enabled: true, createdAt: h.realNow, ...users[username] } as CognitoUser)) },
    invoker,
    now: () => h.realNow,
    newUlid: sequentialIds("LEASE"),
    log: h.deps.log,
    ...(random === undefined ? {} : { random }),
  };
}

/** A visitor's first sign-in, start to end: `ensureWorld`, then the janitor's `GUEST_CREATE`. */
async function signIn(h: WorldsHarness, sub: string, options: { readonly username?: string; readonly users?: Readonly<Record<string, Partial<CognitoUser>>>; readonly random?: () => number } = {}) {
  const invoked: Invoked[] = [];
  const answer = await ensureGuestWorld({ sub, username: options.username ?? `usr-${sub}` }, ensureDeps(h, invoked, options.users, options.random));
  const create = invoked.find((call) => call.target === "WorldJanitor");
  const outcome = create === undefined ? undefined : await createGuestWorld(create.payload as never, h.deps);
  return { answer, outcome, payload: create?.payload, lease: await readAccountWorld(h.stores.client, sub) };
}

describe("[FL-110] the public cap", () => {
  it("with the 60 public worlds taken, a new visitor gets CAPACITY: no world, no slot, the lease FAILED", async () => {
    const h = worldsHarness();
    const invoked: Invoked[] = [];
    const deps = ensureDeps(h, invoked);
    const count = GUEST_SLOTS.public.last - GUEST_SLOTS.public.first + 1;
    for (let index = 0; index < count; index += 1) expect((await ensureGuestWorld({ sub: `sub-${index}`, username: `usr-${index}` }, deps)).state).toBe("CREATING");
    expect(await ensureGuestWorld({ sub: "sub-late", username: "usr-late" }, deps)).toEqual({ state: "CAPACITY" });
    expect(await readAccountWorld(h.stores.client, "sub-late")).toMatchObject({ state: "FAILED", reason: "CAPACITY" });
    expect(invoked.filter((call) => call.target === "WorldJanitor")).toHaveLength(count);
    expect(h.lines.some((line) => line.includes("GuestWorldCapacity"))).toBe(true);
  });
});

describe("[FL-105] [FL-109] TTL and the next sign-in", () => {
  it("destroys a public world after 24 h without activity, then creates another at a higher epoch on the next sign-in", async () => {
    const h = worldsHarness();
    const first = await signIn(h, "sub-a", { random: () => 0 });
    expect(first).toMatchObject({ answer: { state: "CREATING" }, outcome: "READY", lease: { state: "READY", firmId: "firm-guest-31", nn: 31 } });
    expect(await h.stores.client.get("Firms", brokerKey("firm-guest-31", "brk-guest-31"))).toMatchObject({ cognitoSub: "sub-a", cognitoSubKey: "SUB#sub-a", leaseId: first.lease?.leaseId, name: "Invitado", role: "GUEST" });

    h.realNow = new Date(h.realNow.getTime() + 23 * HOUR);
    expect(await sweepGuestWorlds(h.deps)).toEqual({ creationsFailed: 0, worldsDestroyed: 0 });
    h.realNow = new Date(h.realNow.getTime() + 2 * HOUR);
    expect(await sweepGuestWorlds(h.deps)).toEqual({ creationsFailed: 0, worldsDestroyed: 1 });
    expect(await readAccountWorld(h.stores.client, "sub-a")).toMatchObject({ state: "DESTROYED" });
    expect(await readSlot(h.stores.client, 31)).toMatchObject({ releasedAtReal: h.realNow.toISOString() });
    expect(await h.stores.client.get("Firms", brokerKey("firm-guest-31", "brk-guest-31"))).toBeUndefined();

    // 20 minutes later the same slot may be leased again, and the world starts at a higher epoch.
    h.realNow = new Date(h.realNow.getTime() + 21 * 60_000);
    const again = await signIn(h, "sub-a", { random: () => 0 });
    expect(again).toMatchObject({ outcome: "READY", lease: { state: "READY", firmId: "firm-guest-31" } });
    expect((await h.stores.connector.world.getClock("GUEST#firm-guest-31")).worldEpoch).toBe(2);
  });

  it("destroys a public world 72 h after it was leased even when it is in use", async () => {
    const h = worldsHarness();
    await signIn(h, "sub-a", { random: () => 0 });
    const clock = await h.stores.connector.world.getClock("GUEST#firm-guest-31");
    h.realNow = new Date(h.realNow.getTime() + 72 * HOUR);
    await h.stores.connector.world.updateClock(clock.clockId, { lastSession: { originJti: "jti-1", authTime: 1, lastActiveAtReal: h.realNow.toISOString() } } as never, clock.version);
    expect(await sweepGuestWorlds(h.deps)).toMatchObject({ worldsDestroyed: 1 });
  });

  it("does not lease a released slot again before 20 minutes", async () => {
    const h = worldsHarness();
    await signIn(h, "sub-a", { random: () => 0 });
    await destroyGuestWorld({ firmId: "firm-guest-31", reason: "REQUEST" }, h.deps);
    h.realNow = new Date(h.realNow.getTime() + 19 * 60_000);
    const other = await signIn(h, "sub-b", { random: () => 0 });
    expect(other.lease).toMatchObject({ firmId: "firm-guest-32" });
  });

  it("fails a creation still CREATING after 5 minutes and frees its public slot", async () => {
    const h = worldsHarness();
    await ensureGuestWorld({ sub: "sub-a", username: "usr-a" }, ensureDeps(h, [], {}, () => 0));
    h.realNow = new Date(h.realNow.getTime() + 6 * 60_000);
    expect(await sweepGuestWorlds(h.deps)).toEqual({ creationsFailed: 1, worldsDestroyed: 0 });
    expect(await readAccountWorld(h.stores.client, "sub-a")).toMatchObject({ state: "FAILED", reason: "CREATION_TIMEOUT" });
    expect((await readSlot(h.stores.client, 31))?.releasedAtReal).toBeDefined();
  });
});

describe("[FL-118] destroyWorld of a guest world leaves no object behind", () => {
  it("deletes the world's prefix in Documents and Media, its links' uploads and the raw MIME its messages cite", async () => {
    const h = worldsHarness();
    await signIn(h, "sub-a", { random: () => 0 });
    const operation = await h.stores.connector.operations.getOperation("op-4471-g31");
    const prefix = guestWorldPrefix({ guestKind: "PUBLIC", firmId: "firm-guest-31", epoch: operation.worldEpoch });
    h.objects.put("Documents", `${prefix}ops/op-4471-g31/PACKING_LIST/v001-0123abcd.pdf`);
    h.objects.put("Documents", `${prefix.replace("/e1/", "/e0/")}quarantine/old.pdf`);
    h.objects.put("Media", `${prefix}sim/msg-1/1.pdf`);
    h.objects.put("Uploads", `uploads/${TOKEN}/PACKING_LIST/0b6f5c9e-6f3e-4d0e-9b4c-4b1d2c3e4f50.pdf`);
    h.objects.put("InboundMail", `${MAIL_PREFIXES[0]}ses-inbound-1`);
    h.objects.put("Documents", "ops/op-4471/PACKING_LIST/v001-0123abcd.pdf");
    const message = (await h.stores.client.query("Conversations", { hashValue: operationPartition("op-4471-g31") }))[0];
    await h.stores.client.put("Conversations", { ...message, PK: operationPartition("op-4471-g31"), SK: "MSG#2026-10-14T13:40:00.000Z#msg-in1", entity: "Message", channel: "EMAIL", direction: "IN", providerMessageId: "ses-inbound-1", buttons: [{ action: "UPLOAD", title: "Subir", url: `https://legajo.demo.craftech.io/u/${TOKEN}` }] } as never);

    await destroyGuestWorld({ firmId: "firm-guest-31", reason: "REQUEST" }, h.deps);
    expect([...(h.objects.objects.get("Documents") ?? [])]).toEqual(["ops/op-4471/PACKING_LIST/v001-0123abcd.pdf"]);
    expect([...(h.objects.objects.get("Media") ?? [])]).toEqual([]);
    expect([...(h.objects.objects.get("Uploads") ?? [])]).toEqual([]);
    expect([...(h.objects.objects.get("InboundMail") ?? [])]).toEqual([]);
    expect(h.stores.client.dump("Operations").filter((row) => row.clockId === "GUEST#firm-guest-31")).toEqual([]);
    expect(h.stores.client.dump("Platform").filter((row) => String(row.PK).startsWith("POP#firm-guest-31#"))).toEqual([]);
    expect(h.stores.client.dump("Firms").filter((row) => row.PK === "FIRM#firm-guest-31")).toEqual([]);
    expect(await h.stores.connector.world.currentEpoch("GUEST#firm-guest-31")).toBe(1);
  });
});

describe("[FL-109] [FL-087] reserved worlds", () => {
  const reserved = { "guest-03": { firmId: "firm-guest-03" } };

  it("use their own slot whatever the public cap, survive the sweep, and are reset at night only when idle for 24 h", async () => {
    const h = worldsHarness();
    const first = await signIn(h, "sub-r", { username: "guest-03", users: reserved });
    expect(first.lease).toMatchObject({ state: "READY", firmId: "firm-guest-03", nn: 3 });
    await signIn(h, "sub-p", { random: () => 0 });

    h.realNow = new Date(h.realNow.getTime() + 25 * HOUR);
    expect(await sweepGuestWorlds(h.deps)).toMatchObject({ worldsDestroyed: 1 });
    expect(await h.stores.connector.world.findClock("GUEST#firm-guest-03")).toBeDefined();
    expect((await h.stores.client.get("Runtime", slotKey(3)))?.releasedAtReal).toBeUndefined();

    const previous = guestWorldPrefix({ guestKind: "RESERVED", firmId: "firm-guest-03", epoch: 1 });
    h.objects.put("Documents", `${previous}ops/op-4471-g03/PACKING_LIST/v001-0123abcd.pdf`);
    h.objects.put("Media", `${previous}sim/msg-1/1.pdf`);
    const report = await idleGuestReset(h.deps);
    expect([...(h.objects.objects.get("Documents") ?? []), ...(h.objects.objects.get("Media") ?? [])]).toEqual([]);
    expect(report).toMatchObject({ reset: 1, failed: 0 });
    expect((await h.stores.connector.world.getClock("GUEST#firm-guest-03")).worldEpoch).toBe(2);
    expect(await h.stores.client.get("Firms", brokerKey("firm-guest-03", "brk-guest-03"))).toMatchObject({ cognitoSub: "sub-r", leaseId: first.lease?.leaseId });
    // Reset after its last activity: the next night leaves it alone.
    h.realNow = new Date(h.realNow.getTime() + 24 * HOUR);
    expect(await idleGuestReset(h.deps)).toMatchObject({ reset: 0 });
  });
});
