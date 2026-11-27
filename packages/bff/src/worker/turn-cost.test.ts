// Spend cap of a registered guest (ADR-0015 §4): US$1 for the life of the account, charged to the
// person who holds the world and never to the world, held before the Harness and settled to the real
// cost of the turn when it closes.
import { describe, expect, it } from "vitest";
import { guestClockId } from "@legajo/shared";
import { GUEST_AGENT_COST_CAP_USD, TURN_COST_HOLD_USD } from "@legajo/shared/guest-limits";
import { HarnessError } from "../agent/harness-client";
import { seedBrokers } from "../auth/testing";
import { memoryStores } from "../connector/testing";
import type { TableClient } from "../connector/index";
import { createLogger } from "../lib/log";
import { SUBS } from "../routers/testing";
import { GUEST_CAP_TOKEN_RATES, GUEST_CAP_TURN_OVERHEAD_USD, guestTurnCostMicros } from "../services/ratecard";
import { RUNTIME_TABLE } from "../signup/counters";
import { slotKey } from "../worlds/guest-slots";
import { readUsage } from "../worlds/guest-quotas";
import { GUEST_FIRM, GUEST_OPERATION, REAL_NOW, USAGE, completed, turnEvent, workerWorld } from "./testing";
import { COST_CAP_MICROS, COST_HOLD_MICROS, costKey, costOwnerOf, createTurnCostLedger, readGuestCost } from "./turn-cost";

const NOW = new Date(REAL_NOW);
const log = createLogger({ sink: () => undefined, now: () => NOW, level: "debug" });
const ALICE = "sub-alice";
const BRUNO = "sub-bruno";
const PUBLIC_FIRM = "firm-guest-31";
const publicWorld = { firmId: PUBLIC_FIRM, clockId: guestClockId(PUBLIC_FIRM) };

async function bindPublicWorld(stores: ReturnType<typeof memoryStores>, sub: string, extra: Record<string, unknown> = {}): Promise<void> {
  await seedBrokers(stores, [{ firmId: PUBLIC_FIRM, brokerId: "brk-guest-31", role: "GUEST", sub }]);
  await stores.client.put(RUNTIME_TABLE, { ...slotKey(31), entity: "GuestSlot", version: 1, nn: 31, sub, firmId: PUBLIC_FIRM, clockId: publicWorld.clockId, leaseId: `lease-${sub}`, leasedAtReal: REAL_NOW, hardExpiresAtReal: "2026-09-29T15:00:00.000Z", ...extra });
}

async function spend(client: TableClient, sub: string, committedMicros: number): Promise<void> {
  await client.put(RUNTIME_TABLE, { ...costKey(sub), entity: "GuestAgentCost", sub, committedMicros, spentMicros: committedMicros });
}

const guestTurn = (key: string) => turnEvent({ trigger: "FOLLOWUP_DUE", key, operationId: GUEST_OPERATION, clockId: `GUEST#${GUEST_FIRM}`, firmId: GUEST_FIRM });

describe("the price of a turn", () => {
  it("is tokens × the rates of the Harness model plus the overhead, in micro-dollars", () => {
    const expected = 1_200 * GUEST_CAP_TOKEN_RATES.input + 300 * GUEST_CAP_TOKEN_RATES.output + 800 * GUEST_CAP_TOKEN_RATES.cacheRead + GUEST_CAP_TURN_OVERHEAD_USD * 1_000_000;
    expect(guestTurnCostMicros(USAGE)).toBe(Math.ceil(expected));
    expect(guestTurnCostMicros({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 })).toBe(Math.ceil((GUEST_CAP_TOKEN_RATES.cacheWrite + GUEST_CAP_TURN_OVERHEAD_USD) * 1_000_000));
    expect(COST_CAP_MICROS).toBe(GUEST_AGENT_COST_CAP_USD * 1_000_000);
  });
});

describe("who pays a turn", () => {
  it("nobody in a demo, QA or guest-test world; the bound person in a guest world", async () => {
    const stores = memoryStores();
    expect(await costOwnerOf(stores.client, { firmId: "firm-delta", clockId: "GLOBAL#firm-delta" })).toEqual({ kind: "INTERNAL" });
    expect(await costOwnerOf(stores.client, { firmId: "firm-guest-test", clockId: "GUEST#firm-guest-test" })).toEqual({ kind: "INTERNAL" });
    expect(await costOwnerOf(stores.client, publicWorld)).toEqual({ kind: "ORPHAN" });
    await bindPublicWorld(stores, ALICE);
    expect(await costOwnerOf(stores.client, publicWorld)).toEqual({ kind: "GUEST", sub: ALICE });
  });

  it("nobody pays, and nothing runs, in a world whose slot was released or leased to someone else", async () => {
    const released = memoryStores();
    await bindPublicWorld(released, ALICE, { releasedAtReal: REAL_NOW });
    expect(await costOwnerOf(released.client, publicWorld)).toEqual({ kind: "ORPHAN" });
    const ledger = createTurnCostLedger({ client: released.client, now: () => NOW });
    expect(await ledger.hold(publicWorld, log)).toEqual({ allowed: false, reason: "NO_OWNER" });

    const mismatch = memoryStores();
    await bindPublicWorld(mismatch, ALICE, { sub: BRUNO });
    expect(await costOwnerOf(mismatch.client, publicWorld)).toEqual({ kind: "ORPHAN" });
  });
});

describe("[FL-111] the ledger of a person", () => {
  it("of two concurrent turns at the edge only the one whose hold fits opens", async () => {
    const stores = memoryStores();
    await bindPublicWorld(stores, ALICE);
    await spend(stores.client, ALICE, COST_CAP_MICROS - COST_HOLD_MICROS - 10_000);
    const ledger = createTurnCostLedger({ client: stores.client, now: () => NOW });
    const decisions = await Promise.all([ledger.hold(publicWorld, log), ledger.hold(publicWorld, log), ledger.hold(publicWorld, log)]);
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.allowed)).toEqual([
      { allowed: false, reason: "EXHAUSTED" },
      { allowed: false, reason: "EXHAUSTED" },
    ]);
    const [open] = decisions.filter((decision) => decision.allowed);
    if (open?.allowed !== true) throw new Error("one turn should open");
    await open.hold.settle(USAGE);
    await open.hold.settle(USAGE);
    const cost = await readGuestCost(stores.client, ALICE);
    expect(cost.committedMicros).toBe(cost.spentMicros);
    expect(cost.spentMicros).toBe(COST_CAP_MICROS - COST_HOLD_MICROS - 10_000 + guestTurnCostMicros(USAGE));
    expect(await ledger.hold(publicWorld, log)).toEqual({ allowed: false, reason: "EXHAUSTED" });
  });

  it("follows the person, not the world: a reused slot starts its new holder at zero and the old one stays spent", async () => {
    const stores = memoryStores();
    const ledger = createTurnCostLedger({ client: stores.client, now: () => NOW });
    await bindPublicWorld(stores, ALICE);
    await spend(stores.client, ALICE, COST_CAP_MICROS);
    expect(await ledger.hold(publicWorld, log)).toEqual({ allowed: false, reason: "EXHAUSTED" });

    // The world is destroyed and the same slot goes to Bruno: his turns run on his own ledger.
    await bindPublicWorld(stores, BRUNO, { version: 2 });
    const bruno = await ledger.hold(publicWorld, log);
    expect(bruno.allowed).toBe(true);
    if (bruno.allowed) await bruno.hold.settle(USAGE);
    expect((await readGuestCost(stores.client, BRUNO)).spentMicros).toBe(guestTurnCostMicros(USAGE));
    expect((await readGuestCost(stores.client, ALICE)).spentMicros).toBe(COST_CAP_MICROS);

    // Alice in a new world, another slot: still spent.
    const other = { firmId: "firm-guest-32", clockId: guestClockId("firm-guest-32") };
    await seedBrokers(stores, [{ firmId: other.firmId, brokerId: "brk-guest-32", role: "GUEST", sub: ALICE }]);
    expect(await ledger.hold(other, log)).toEqual({ allowed: false, reason: "EXHAUSTED" });
  });

  it("a hold given back leaves nothing; one kept charges the hold", async () => {
    const stores = memoryStores();
    await bindPublicWorld(stores, ALICE);
    const ledger = createTurnCostLedger({ client: stores.client, now: () => NOW });
    const first = await ledger.hold(publicWorld, log);
    if (first.allowed) await first.hold.release();
    expect(await readGuestCost(stores.client, ALICE)).toEqual({ committedMicros: 0, spentMicros: 0 });
    const second = await ledger.hold(publicWorld, log);
    if (second.allowed) {
      await second.hold.keep();
      await second.hold.release();
    }
    expect(await readGuestCost(stores.client, ALICE)).toEqual({ committedMicros: COST_HOLD_MICROS, spentMicros: COST_HOLD_MICROS });
  });
});

describe("[FL-111] a guest turn past the cap", () => {
  it("has no turn: note TURN_COST, audited once, GuestCostHits, no Harness, no outbound; account.usage says EXHAUSTED", async () => {
    const world = await workerWorld({ guestWorld: true, harness: [completed(), completed()] });
    await spend(world.stores.client, SUBS.guest, COST_CAP_MICROS - COST_HOLD_MICROS);
    await world.deliver(guestTurn("c1"));
    await world.deliver(guestTurn("c2"));
    expect(world.harness.requests).toHaveLength(1);
    const notes = (await world.stores.connector.conversations.listTurnNotes(GUEST_OPERATION)).map((note) => note.text);
    expect(notes.filter((text) => text === "TURN_COST")).toHaveLength(1);
    const rows = (await world.stores.connector.audit.listByOperation(GUEST_OPERATION)).filter((decision) => decision.action === "TURN_COST");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toEqual({ reason: "EXHAUSTED" });
    expect(world.metrics("GuestCostHits")).toEqual([expect.objectContaining({ reason: "EXHAUSTED" })]);
    expect(world.sent).toEqual([]);
    const usage = await readUsage(world.stores.client, { sub: SUBS.guest, clockId: `GUEST#${GUEST_FIRM}` }, world.realNow());
    expect(usage.agentBudget).toBe("EXHAUSTED");
  });

  it("a turn the Harness failed without usage keeps its hold; a throttled one gives it back", async () => {
    const world = await workerWorld({ guestWorld: true, harness: [new HarnessError("TIMEOUT", "deadline"), new HarnessError("THROTTLED", "slow down")] });
    await world.deliver(guestTurn("t1"));
    expect(await readGuestCost(world.stores.client, SUBS.guest)).toEqual({ committedMicros: COST_HOLD_MICROS, spentMicros: COST_HOLD_MICROS });
    await world.deliver(guestTurn("t2")).catch(() => undefined);
    expect(await readGuestCost(world.stores.client, SUBS.guest)).toEqual({ committedMicros: COST_HOLD_MICROS, spentMicros: COST_HOLD_MICROS });
    expect(TURN_COST_HOLD_USD * 1_000_000).toBe(COST_HOLD_MICROS);
  });

  it("an internal world is never charged", async () => {
    const world = await workerWorld({ harness: [completed()] });
    await world.deliver(turnEvent({ trigger: "FOLLOWUP_DUE", key: "i1" }));
    expect(world.harness.requests).toHaveLength(1);
    expect(await world.stores.client.scan(RUNTIME_TABLE, { filter: { equals: { entity: "GuestAgentCost" } } })).toEqual([]);
  });
});
