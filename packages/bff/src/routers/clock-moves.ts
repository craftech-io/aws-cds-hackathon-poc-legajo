// The commands of the `clock` router (docs/tool-catalog.md `advance_clock`, `move_eta`,
// `emit_dispatch_status`, `reset_demo_world`; docs/architecture.md §8; ADR-0015 §4), over the clock
// module (clock/advance.ts, clock/modes.ts, clock/reset.ts) and the platform's feeds. In order:
//
//   1. the world: the one the input names (fenced by `firmProcedure`) or the firm's own; an operation's
//      world for the commands that name an operation;
//   2. from the console, a move or an injection needs a quiet world (`assertWorldQuiet`: `WORLD_BUSY`,
//      or `force` once the oldest pending waited five minutes, audited `CLOCK_FORCED`); the `QaDriver`
//      passes no gate and waits with `op.settle`;
//   3. a guest world spends one unit of the command's quota (`CLOCK_MOVES`, `LIVE_CLOCK` when the live
//      clock turns on, `WORLD_RESETS`): `QUOTA_EXCEEDED {kind, resetsAtReal}` and nothing moves;
//   4. the command, then the world's snapshot as `clock.get` would answer it.
//
// Every command answers the snapshot so the shell can redraw before its next poll.
import { z } from "zod";
import { PublishedDispatchStatus } from "@legajo/platform-mock/events";
import { ClockId, ClockResetInput, CustomsChannel, IsoInstant, MilestoneName, OperationId } from "@legajo/shared";
import type { QuotaKind } from "@legajo/shared/guest-limits";
import { type ClockDeps, type ClockTarget, MAX_MOVE_MS, advanceClock, fireMilestoneNow } from "../clock/advance";
import { assertWorldQuiet } from "../clock/busy";
import { setRunning } from "../clock/modes";
import { ResetTooSoonError, nextConsoleResetAtReal, resetWorld } from "../clock/reset";
import { simNowOf } from "../lib/clock";
import { ulid } from "../lib/crypto";
import { actorOfCaller } from "../services/operations-admin/handler-kit";
import { callerOf, consoleServicesOf, consumeConsoleQuota, resetDepsOf } from "./console-services";
import { type FirmContext, brokerProcedure, firmProcedure } from "./trpc";
import { clockSnapshot, worldOf } from "./world";

const MAX_MOVE_MINUTES = MAX_MOVE_MS / 60_000;

const World = { clockId: ClockId.optional() };
/** "Avanzar igual": accepted only once the oldest pending waited five minutes (clock/busy.ts). */
const Force = { force: z.boolean().optional() };

export const AdvanceInput = z.object({ ...World, minutes: z.number().int().min(1).max(MAX_MOVE_MINUTES), ...Force }).strict();
export const AdvanceToInput = z.object({ ...World, toSim: IsoInstant, ...Force }).strict();
export const AdvanceToNextInput = z.object({ ...World, ...Force }).strict().prefault({});
export const SetRunningInput = z.object({ ...World, running: z.boolean() }).strict();
export const FireMilestoneInput = z.object({ operationId: OperationId, milestone: MilestoneName, ...Force }).strict();
export const MoveEtaInput = z.object({ operationId: OperationId, eta: IsoInstant, ...Force }).strict();
export const EmitDispatchStatusInput = z
  .object({ operationId: OperationId, status: PublishedDispatchStatus, channel: CustomsChannel.optional(), ...Force })
  .strict()
  .refine((input) => (input.status === "CANAL_ASIGNADO") === (input.channel !== undefined), "a channel goes with CANAL_ASIGNADO and only with it");

type MoveQuota = Extract<QuotaKind, "CLOCK_MOVES">;

/** The clock module over the services of the request, on the request's real clock. */
function clockDepsOf(ctx: FirmContext): ClockDeps & { readonly data: ClockDeps["data"] & Pick<FirmContext["deps"]["connector"], "operations"> } {
  const { services } = consoleServicesOf(ctx.deps);
  return { ...services.timers, data: services.connector, realClock: ctx.deps.wallClock };
}

function actorOf(ctx: FirmContext) {
  return actorOfCaller(callerOf(ctx.principal));
}

/** Steps 2 and 3: the console's quiet-world gate, then the guest world's quota. Answers whether it was forced. */
async function admitMove(ctx: FirmContext, clockId: string, force: boolean | undefined, quota: MoveQuota): Promise<boolean> {
  let forced = false;
  if (callerOf(ctx.principal).kind === "CONSOLE") {
    const gate = await assertWorldQuiet(
      { clockId, firmId: ctx.principal.firmId, actor: actorOf(ctx), correlationId: ctx.correlationId, ...(force === undefined ? {} : { force }) },
      { data: ctx.deps.connector, realClock: ctx.deps.wallClock },
    );
    forced = gate.forced;
  }
  await consumeConsoleQuota(ctx, clockId, quota);
  return forced;
}

async function move(ctx: FirmContext, requested: string | undefined, force: boolean | undefined, target: ClockTarget) {
  const clockId = await worldOf(ctx, requested);
  const forced = await admitMove(ctx, clockId, force, "CLOCK_MOVES");
  const moved = await advanceClock({ clockId, target, caller: { actor: actorOf(ctx), correlationId: ctx.correlationId } }, clockDepsOf(ctx));
  return { ...(await clockSnapshot(ctx, clockId)), fired: moved.fired.length, forced };
}

/** The operation a command names, fenced to the principal's firm. */
async function operationOf(ctx: FirmContext, operationId: string) {
  const operation = await ctx.deps.connector.operations.getOperation(operationId);
  await ctx.firmScope.assertFirm(operation.firmId);
  return operation;
}

/** The world's simulated now, the instant a feed event says it happened at. */
async function simNowIn(ctx: FirmContext, clockId: string): Promise<string> {
  const clock = await ctx.deps.connector.world.getClock(clockId);
  return simNowOf(clock, ctx.deps.wallClock().getTime()).toISOString();
}

async function auditInjection(ctx: FirmContext, operation: { readonly firmId: string; readonly clockId: string; readonly operationId: string }, action: string, atSim: string, detail: Readonly<Record<string, unknown>>): Promise<void> {
  await ctx.deps.connector.audit.record({
    firmId: operation.firmId,
    decision: "ACTION",
    action,
    actor: actorOf(ctx),
    clockId: operation.clockId,
    operationId: operation.operationId,
    refs: { operationId: operation.operationId, ...(ctx.principal.brokerId === undefined ? {} : { brokerId: ctx.principal.brokerId }) },
    atSim,
    atReal: ctx.deps.wallClock().toISOString(),
    correlationId: ctx.correlationId,
    detail: { ...detail },
  });
}

/** `Idempotency-Key` of one console injection: one call, one event (a retry of the same call is a new click). */
function injectionKey(ctx: FirmContext): string {
  return `console:${ulid(ctx.deps.wallClock().getTime())}`;
}

export const clockMoves = {
  advance: firmProcedure.input(AdvanceInput).mutation(({ ctx, input }) => move(ctx, input.clockId, input.force, { byMinutes: input.minutes })),
  advanceTo: firmProcedure.input(AdvanceToInput).mutation(({ ctx, input }) => move(ctx, input.clockId, input.force, { to: input.toSim })),
  advanceToNext: firmProcedure.input(AdvanceToNextInput).mutation(({ ctx, input }) => move(ctx, input.clockId, input.force, { next: true })),

  /** "Reloj en vivo": RUNNING for 30 real minutes, or back to PAUSED; turning it on spends one `LIVE_CLOCK`. */
  setRunning: firmProcedure.input(SetRunningInput).mutation(async ({ ctx, input }) => {
    const clockId = await worldOf(ctx, input.clockId);
    if (input.running) await consumeConsoleQuota(ctx, clockId, "LIVE_CLOCK");
    await setRunning({ clockId, running: input.running, caller: { actor: actorOf(ctx), correlationId: ctx.correlationId } }, clockDepsOf(ctx));
    return clockSnapshot(ctx, clockId);
  }),

  /** "Disparar ahora": the milestone fires at the world's now (`firedBy MANUAL`) without moving the clock. */
  fireMilestone: firmProcedure.input(FireMilestoneInput).mutation(async ({ ctx, input }) => {
    const operation = await operationOf(ctx, input.operationId);
    const forced = await admitMove(ctx, operation.clockId, input.force, "CLOCK_MOVES");
    await fireMilestoneNow({ operationId: operation.operationId, milestone: input.milestone, caller: { actor: actorOf(ctx), correlationId: ctx.correlationId } }, clockDepsOf(ctx));
    return { ...(await clockSnapshot(ctx, operation.clockId)), forced };
  }),

  /** "Mover ETA": the platform publishes `CarrierEtaChanged` to `Feeds`; the milestones follow by `ETA_CHANGED`. */
  moveEta: firmProcedure.input(MoveEtaInput).mutation(async ({ ctx, input }) => {
    const operation = await operationOf(ctx, input.operationId);
    const forced = await admitMove(ctx, operation.clockId, input.force, "CLOCK_MOVES");
    const atSim = await simNowIn(ctx, operation.clockId);
    await consoleServicesOf(ctx.deps).feeds.moveEta({ firmId: operation.firmId, operationNumber: operation.operationNumber, newEta: input.eta, occurredAtSim: atSim, idempotencyKey: injectionKey(ctx) });
    await auditInjection(ctx, operation, "PLATFORM_ETA_MOVED", atSim, { fromEta: operation.eta, toEta: input.eta, forced });
    return { ...(await clockSnapshot(ctx, operation.clockId)), forced };
  }),

  /** "Emitir estado": the platform publishes `CustomsStatusChanged` (only forward, after approval). */
  emitDispatchStatus: firmProcedure.input(EmitDispatchStatusInput).mutation(async ({ ctx, input }) => {
    const operation = await operationOf(ctx, input.operationId);
    const forced = await admitMove(ctx, operation.clockId, input.force, "CLOCK_MOVES");
    const atSim = await simNowIn(ctx, operation.clockId);
    const channel = input.channel === undefined ? {} : { channel: input.channel };
    await consoleServicesOf(ctx.deps).feeds.customsStatus({ firmId: operation.firmId, operationNumber: operation.operationNumber, status: input.status, ...channel, occurredAtSim: atSim, idempotencyKey: injectionKey(ctx) });
    await auditInjection(ctx, operation, "PLATFORM_STATUS_EMITTED", atSim, { status: input.status, ...channel, forced });
    return { ...(await clockSnapshot(ctx, operation.clockId)), forced };
  }),

  /** "Reiniciar demo": the user's own world (firm-qa names one), BROKER or GUEST. */
  reset: brokerProcedure.input(ClockResetInput.prefault({})).mutation(async ({ ctx, input }) => {
    const clockId = await worldOf(ctx, input.clockId);
    const caller = callerOf(ctx.principal);
    if (caller.kind === "CONSOLE") {
      // Checked before the quota so a refused reset spends nothing; resetWorld checks it again on the clock's version.
      const clock = await ctx.deps.connector.world.getClock(clockId);
      const next = nextConsoleResetAtReal(clock.lastResetAtReal, ctx.deps.wallClock());
      if (next !== undefined) throw new ResetTooSoonError(next);
    }
    await consumeConsoleQuota(ctx, clockId, "WORLD_RESETS");
    const services = consoleServicesOf(ctx.deps);
    const reset = await resetWorld({ clockId, caller: caller.kind === "QA" ? "QA" : "CONSOLE", actor: actorOf(ctx), correlationId: ctx.correlationId }, { ...resetDepsOf(services), realClock: ctx.deps.wallClock });
    return { ...(await clockSnapshot(ctx, clockId)), previousEpoch: reset.previousEpoch };
  }),
};
