import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { QuotaExceededError } from "@legajo/shared/errors";
import type { QuotaKind } from "@legajo/shared/guest-limits";
import { CLOCK, REAL_NOW } from "../connector/testing";
import { scheduleMilestones } from "../milestones/schedule";
import { FIRM, OPERATION, readyForReview } from "../services/operations-admin/testing";
import { type ConsoleServiceWorld, GUEST, GUEST_CLOCK, consoleServiceWorld } from "./console-testing";
import { type ConsoleWorld, DIEGO, MARTINA, PABLO, SUBS, consoleWorld, principalOf } from "./testing";

const at = (iso: string) => new Date(iso).getTime();

async function refusalOf(work: Promise<unknown>): Promise<TRPCError> {
  const error = await work.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(error instanceof TRPCError)) throw new Error("expected a refusal");
  return error;
}

async function expectQuota(work: Promise<unknown>, kind: QuotaKind): Promise<void> {
  const error = await refusalOf(work);
  expect(error.code).toBe("TOO_MANY_REQUESTS");
  expect(error.cause).toBeInstanceOf(QuotaExceededError);
  expect(error.cause).toMatchObject({ kind, resetsAtReal: expect.any(String) });
}

async function withMilestones(world: ConsoleServiceWorld): Promise<void> {
  const operation = await world.stores.connector.operations.getOperation(OPERATION);
  await scheduleMilestones({ operation }, world.deps.timers);
}

describe("clock router", () => {
  let world: ConsoleWorld;

  beforeEach(async () => {
    world = await consoleWorld();
  });

  it("reads the world's mode, simulated now, epoch and next events", async () => {
    const { timers } = world.stores.connector;
    await timers.createTimer({ operationId: "op-4471", clockId: CLOCK, kind: "MILESTONE", timerId: "FOLLOWUP", dueAtSim: "2026-10-17T10:00:00-03:00", status: "SCHEDULED" });
    await timers.createTimer({ operationId: "op-4471", clockId: CLOCK, kind: "MILESTONE", timerId: "DOCS_REQUEST", dueAtSim: "2026-10-15T10:00:00-03:00", status: "SCHEDULED" });
    const clock = await world.caller(DIEGO).clock.get({});
    expect(clock).toMatchObject({ clockId: CLOCK, mode: "PAUSED", simNow: "2026-10-14T13:30:00.000Z", runningUntilReal: null, worldEpoch: 1, busy: false, pending: [], stale: [], reset: { allowed: true } });
    // The shell asks with no input at all.
    expect((await world.caller(DIEGO).clock.get()).clockId).toBe(CLOCK);
    expect(clock.nextEvents.map((event) => [event.operationNumber, event.timerId])).toEqual([
      ["4471", "DOCS_REQUEST"],
      ["4471", "FOLLOWUP"],
    ]);
  });

  it("is busy while an event is in flight or a mail is in transit, and not for a stale one", async () => {
    const { world: state } = world.stores.connector;
    await state.markInFlight({ operationId: "op-4471", clockId: CLOCK, eventId: "evt-1" });
    await state.putMailPending({ clockId: CLOCK, mailId: "mail-00000001", operationId: "op-4471", from: "op-4471-k7p2q9@legajo.demo.craftech.io", to: "supplier-qingdao@sim.legajo.demo.craftech.io", profile: "SYSTEM", awaiting: "SIMMAIL", sentAtReal: REAL_NOW, staleAtReal: "2026-09-26T14:00:00.000Z", expiresAt: 1 });
    const clock = await world.caller(DIEGO).clock.get({});
    expect(clock.busy).toBe(true);
    expect(clock.pending).toEqual([{ kind: "EVENT", operationNumber: "4471", detail: "evt-1", sinceReal: REAL_NOW, stale: false }]);
    expect(clock.stale).toEqual([{ kind: "MAIL", operationNumber: "4471", detail: "SIMMAIL", sinceReal: REAL_NOW, stale: true }]);
    await state.settleInFlight({ operationId: "op-4471", clockId: CLOCK, eventId: "evt-1" });
    expect((await world.caller(DIEGO).clock.get({})).busy).toBe(false);
  });

  it("closes the console's reset for ten minutes after the last one", async () => {
    await world.stores.connector.world.updateClock(CLOCK, { lastResetAtReal: "2026-09-26T14:55:00.000Z" });
    expect((await world.caller(DIEGO).clock.get({})).reset).toEqual({ allowed: false, nextAllowedAtReal: "2026-09-26T15:05:00.000Z" });
  });

  it("asks a firm with several worlds to name one, and fences the one it names", async () => {
    const qa = principalOf("firm-qa", "BROKER", SUBS.diego, "brk-qa-runner");
    await expect(world.caller(qa).clock.get({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(world.caller(PABLO).clock.get({ clockId: CLOCK })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("clock router: moves", () => {
  it("[FL-065] advances a quiet world, fires what fell due at its own instant and answers the new snapshot", async () => {
    const world = await consoleServiceWorld();
    await world.stores.connector.timers.createTimer({ operationId: OPERATION, clockId: CLOCK, kind: "FOLLOWUP_DUE", timerId: "fu-1", dueAtSim: "2026-10-14T11:00:00-03:00", status: "SCHEDULED" });
    const moved = await world.caller(MARTINA).clock.advance({ minutes: 60 });
    expect(at(moved.simNow)).toBe(at("2026-10-14T11:30:00-03:00"));
    expect(moved).toMatchObject({ clockId: CLOCK, mode: "PAUSED", fired: 1, forced: false });
    expect(world.dispatched.map((due) => due.timer.timerId)).toEqual(["fu-1"]);
    const advanced = (await world.stores.connector.audit.listByDecision(FIRM, "ACTION")).find((row) => row.action === "CLOCK_ADVANCED");
    expect(advanced).toMatchObject({ actor: "BROKER:brk-delta-martina", detail: { move: "ADVANCE" } });
  });

  it("[FL-065] advanceTo goes forward only and advanceToNext reaches the next timer of any kind", async () => {
    const world = await consoleServiceWorld();
    await withMilestones(world);
    await expect(world.caller(DIEGO).clock.advanceTo({ toSim: "2026-10-13T10:00:00-03:00" })).rejects.toMatchObject({ code: "BAD_REQUEST", cause: { reason: "CLOCK_BACKWARDS" } });
    const next = await world.caller(DIEGO).clock.advanceToNext({});
    const [first] = (await world.stores.connector.timers.listTimers(OPERATION, { kind: "MILESTONE" })).sort((a, b) => at(a.dueAtSim) - at(b.dueAtSim));
    expect(at(next.simNow)).toBe(at(first?.dueAtSim ?? ""));
    await expect(world.caller(DIEGO).clock.advance({ minutes: 14 * 24 * 60 + 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("[FL-065] a busy world refuses every move with WORLD_BUSY; force only after five minutes of the same wait, audited CLOCK_FORCED", async () => {
    const world = await consoleServiceWorld();
    await withMilestones(world);
    await world.stores.connector.world.markInFlight({ operationId: OPERATION, clockId: CLOCK, eventId: "evt-1" });
    const before = (await world.caller(DIEGO).clock.get({})).simNow;
    const refusals = [
      world.caller(DIEGO).clock.advance({ minutes: 60 }),
      world.caller(DIEGO).clock.advanceToNext({}),
      world.caller(DIEGO).clock.fireMilestone({ operationId: OPERATION, milestone: "DOCS_REQUEST" }),
      world.caller(DIEGO).clock.moveEta({ operationId: OPERATION, eta: "2026-10-26T08:00:00-03:00" }),
      world.caller(DIEGO).clock.advance({ minutes: 60, force: true }),
    ];
    for (const refusal of refusals) expect(await refusalOf(refusal)).toMatchObject({ code: "CONFLICT", cause: { reason: "WORLD_BUSY" } });
    expect((await world.caller(DIEGO).clock.get({})).simNow).toBe(before);
    expect(world.feeds).toEqual([]);

    world.advanceReal(5 * 60_000 + 1_000);
    expect(await world.caller(DIEGO).clock.advance({ minutes: 60, force: true })).toMatchObject({ forced: true });
    expect((await world.stores.connector.audit.listByDecision(FIRM, "ACTION")).map((row) => row.action)).toEqual(expect.arrayContaining(["CLOCK_FORCED", "CLOCK_ADVANCED"]));
  });

  it("[FL-065] «Disparar ahora» fires the milestone at the world's now without moving the clock", async () => {
    const world = await consoleServiceWorld();
    await withMilestones(world);
    const before = (await world.caller(DIEGO).clock.get({})).simNow;
    const fired = await world.caller(DIEGO).clock.fireMilestone({ operationId: OPERATION, milestone: "FOLLOWUP" });
    expect(fired.simNow).toBe(before);
    expect(world.dispatched.at(-1)).toMatchObject({ firedBy: "MANUAL", eventAtSim: before });
    await expect(world.caller(PABLO).clock.fireMilestone({ operationId: OPERATION, milestone: "FOLLOWUP" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("«Reloj en vivo» runs the world for 30 real minutes and pauses it again", async () => {
    const world = await consoleServiceWorld();
    const running = await world.caller(DIEGO).clock.setRunning({ running: true });
    expect(running).toMatchObject({ mode: "RUNNING", runningUntilReal: "2026-09-26T15:30:00.000Z" });
    expect(await world.caller(DIEGO).clock.setRunning({ running: false })).toMatchObject({ mode: "PAUSED", runningUntilReal: null });
  });

  it("[FL-061] moves the ETA through the platform at the world's simulated now, audited; and emits a dispatch status with its channel", async () => {
    const world = await consoleServiceWorld();
    const simNow = (await world.caller(DIEGO).clock.get({})).simNow;
    await world.caller(DIEGO).clock.moveEta({ operationId: OPERATION, eta: "2026-10-26T08:00:00-03:00" });
    expect(world.feeds).toMatchObject([{ kind: "ETA", input: { firmId: FIRM, operationNumber: "4471", newEta: "2026-10-26T08:00:00-03:00", occurredAtSim: simNow, idempotencyKey: expect.stringMatching(/^console:/) } }]);
    await readyForReview(world);
    await expect(world.caller(DIEGO).clock.emitDispatchStatus({ operationId: OPERATION, status: "CANAL_ASIGNADO" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await world.caller(DIEGO).clock.emitDispatchStatus({ operationId: OPERATION, status: "CANAL_ASIGNADO", channel: "VERDE" });
    expect(world.feeds.at(-1)).toMatchObject({ kind: "STATUS", input: { status: "CANAL_ASIGNADO", channel: "VERDE" } });
    const actions = (await world.stores.connector.audit.listByOperation(OPERATION)).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["PLATFORM_ETA_MOVED", "PLATFORM_STATUS_EMITTED"]));
  });

  it("[FL-087] «Reiniciar demo»: BROKER or GUEST only, a new epoch from the world factory, then closed for ten minutes", async () => {
    const world = await consoleServiceWorld();
    await expect(world.caller(MARTINA).clock.reset({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    const reset = await world.caller(DIEGO).clock.reset({});
    expect(reset).toMatchObject({ clockId: CLOCK, worldEpoch: 2, previousEpoch: 1, mode: "PAUSED", reset: { allowed: false } });
    expect(world.reloads).toMatchObject([{ clockId: CLOCK, firmId: FIRM, worldEpoch: 2, previousEpoch: 1 }]);
    expect(world.purges).toMatchObject([{ clockId: CLOCK, previousEpoch: 1, importerIds: ["imp-norpampa"] }]);
    expect(await refusalOf(world.caller(DIEGO).clock.reset({}))).toMatchObject({ code: "CONFLICT", cause: { reason: "RESET_TOO_SOON" } });
    expect(world.reloads).toHaveLength(1);
  });
});

describe("clock router: a guest world's quotas [FL-111]", () => {
  it("[FL-111] CLOCK_MOVES: every move and injection is refused with QUOTA_EXCEEDED and the world does not move", async () => {
    const world = await consoleServiceWorld({ guestWorld: true });
    expect(await world.caller(GUEST).clock.advance({ minutes: 60 })).toMatchObject({ clockId: GUEST_CLOCK });
    await world.exhaust(GUEST_CLOCK, "CLOCK_MOVES");
    const before = (await world.caller(GUEST).clock.get({})).simNow;
    await expectQuota(world.caller(GUEST).clock.advance({ minutes: 60 }), "CLOCK_MOVES");
    await expectQuota(world.caller(GUEST).clock.advanceToNext({}), "CLOCK_MOVES");
    expect((await world.caller(GUEST).clock.get({})).simNow).toBe(before);
    // Demo worlds have no quota.
    expect(await world.caller(DIEGO).clock.advance({ minutes: 60 })).toMatchObject({ clockId: CLOCK });
  });

  it("[FL-111] LIVE_CLOCK: turning the live clock on is refused; turning it off never is", async () => {
    const world = await consoleServiceWorld({ guestWorld: true });
    await world.exhaust(GUEST_CLOCK, "LIVE_CLOCK");
    await expectQuota(world.caller(GUEST).clock.setRunning({ running: true }), "LIVE_CLOCK");
    expect(await world.caller(GUEST).clock.setRunning({ running: false })).toMatchObject({ mode: "PAUSED" });
  });

  it("[FL-111] WORLD_RESETS: the reset is refused and the world keeps its epoch", async () => {
    const world = await consoleServiceWorld({ guestWorld: true });
    await world.exhaust(GUEST_CLOCK, "WORLD_RESETS");
    await expectQuota(world.caller(GUEST).clock.reset({}), "WORLD_RESETS");
    expect(world.reloads).toEqual([]);
    expect((await world.stores.connector.world.getClock(GUEST_CLOCK)).worldEpoch).toBe(1);
  });
});
