// Turn quota of the guest worlds (ADR-0015 §4): before `InvokeHarness`, 30 turns an hour and 120 a
// day per `GUEST#*` world, and the daily budget of 1,500 turns of all public worlds, through
// `consumeQuota` of worlds/guest-quotas.ts. Past either, there is no turn: the event closes with the
// note `TURN_QUOTA`, `QuotaHits` or `GuestBudgetHits`, and nothing is sent.
import { describe, expect, it } from "vitest";
import { PUBLIC_GLOBAL_BUDGET } from "@legajo/shared/guest-limits";
import { counterKey, RUNTIME_TABLE } from "../signup/counters";
import { GUEST_CLOCK, GUEST_FIRM, GUEST_OPERATION, completed, seedGuestOperation, turnEvent, workerWorld } from "./testing";

const guestTurn = (key: string, operationId = GUEST_OPERATION, firmId = GUEST_FIRM) => turnEvent({ trigger: "FOLLOWUP_DUE", key, operationId, clockId: `GUEST#${firmId}`, firmId });

async function quotaRows(world: Awaited<ReturnType<typeof workerWorld>>, operationId: string) {
  return (await world.stores.connector.audit.listByOperation(operationId)).filter((decision) => decision.action === "TURN_QUOTA");
}

describe("turn quota of a guest world", () => {
  it("the 31st turn in a real hour has no turn: note TURN_QUOTA, QuotaHits, no Harness and no outbound", async () => {
    const world = await workerWorld({ guestWorld: true, harness: Array.from({ length: 31 }, () => completed()) });
    for (let index = 0; index < 31; index += 1) await world.deliver(guestTurn(`t${index}`));
    expect(world.harness.requests).toHaveLength(30);
    const notes = (await world.stores.connector.conversations.listTurnNotes(GUEST_OPERATION)).filter((note) => note.text === "TURN_QUOTA");
    expect(notes).toHaveLength(1);
    const [row] = await quotaRows(world, GUEST_OPERATION);
    expect(row?.detail).toMatchObject({ kind: "AGENT_TURNS" });
    expect(Date.parse(String(row?.detail?.["resetsAtReal"]))).toBeGreaterThan(world.realNow().getTime());
    expect(world.metrics("QuotaHits")).toEqual([expect.objectContaining({ kind: "AGENT_TURNS" })]);
    expect(world.sent).toEqual([]);
    // A refused turn counts nothing: the firm's cap saw only the 30 that ran.
    const hour = await world.stores.connector.runtime.incrementTurnCap({ firmId: GUEST_FIRM, window: `H${world.realNow().toISOString().slice(0, 13)}` });
    expect(hour).toBe(31);
  });

  it("the daily limit of 120 holds across hours", async () => {
    const world = await workerWorld({ guestWorld: true, harness: Array.from({ length: 121 }, () => completed()) });
    for (let hour = 0; hour < 4; hour += 1) {
      for (let index = 0; index < 30; index += 1) await world.deliver(guestTurn(`d${hour}-${index}`));
      world.advanceReal(60 * 60_000);
    }
    expect(world.harness.requests).toHaveLength(120);
    await world.deliver(guestTurn("d-last"));
    expect(world.harness.requests).toHaveLength(120);
    expect(await quotaRows(world, GUEST_OPERATION)).toHaveLength(1);
  });

  it("a public world past the global budget of the day: GuestBudgetHits, kind GLOBAL, no turn", async () => {
    const world = await workerWorld({ harness: [completed()] });
    const operationId = await seedGuestOperation(world.stores, "firm-guest-31", "7031");
    const budget = PUBLIC_GLOBAL_BUDGET.AGENT_TURNS ?? 0;
    await world.stores.client.put(RUNTIME_TABLE, { ...counterKey("QUOTA#GUEST_PUBLIC#AGENT_TURNS", "DAY", world.realNow()), entity: "WindowCounter", count: budget });
    await world.deliver(guestTurn("g1", operationId, "firm-guest-31"));
    expect(world.harness.requests).toEqual([]);
    expect((await quotaRows(world, operationId))[0]?.detail).toMatchObject({ kind: "GLOBAL" });
    expect(world.metrics("GuestBudgetHits")).toEqual([expect.objectContaining({ kind: "AGENT_TURNS" })]);
    expect((await world.stores.connector.conversations.listTurnNotes(operationId)).map((note) => note.text)).toEqual(["TURN_QUOTA"]);
  });

  it("a reserved guest world does not spend the public budget", async () => {
    const world = await workerWorld({ guestWorld: true, harness: [completed()] });
    await world.deliver(guestTurn("r1"));
    expect(await world.stores.client.get(RUNTIME_TABLE, counterKey("QUOTA#GUEST_PUBLIC#AGENT_TURNS", "DAY", world.realNow()))).toBeUndefined();
    expect(await world.stores.client.get(RUNTIME_TABLE, counterKey(`QUOTA#${GUEST_CLOCK}#AGENT_TURNS`, "HOUR", world.realNow()))).toMatchObject({ count: 1 });
  });
});
