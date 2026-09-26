// Worlds of a scenario and the moves every scenario repeats (docs/test-plan.md §4.2):
//
//   createWorld     `world.create` (idempotent by run and scenario), registered for the cleanup
//   advance*        always `op.settle` first, then the frozen clock moves: to the next timer of the
//                   operation, to a given instant, or to the next timer of the world
//   schedulerProbe  the only real wait for the Scheduler: `clock.unfreeze({leadSec: 120})`, the real
//                   schedule fires within 240 s (`firedBy SCHEDULER`), `clock.freeze`
//   awaitMessage    the first message of a kind, within the wait of the path it travels
//   cleanupWorlds   per world, `policyAudit.run` (kept for the report and SC-20) and `world.destroy`
import type { WorldCreated, WorldOperationCreated } from "@legajo/bff/qa-driver/ports";
import type { QaSnapshot } from "@legajo/bff/qa-driver/snapshot";
import type { WorldOperation } from "@legajo/bff/qa-driver/contract-inputs";
import { type MessageFilter, messages, sameInstant } from "./asserts";
import { WAITS } from "./eventually";
import { type ScenarioContext, ensure } from "./steps";

const REGISTRY = "__worlds";

export interface WorldSpec {
  /** Second world of a scenario (`sc18-rate`): suffix of its clock. */
  readonly suffix?: string;
  readonly startAtSim: string;
  readonly operations: readonly WorldOperation[];
  readonly rateLimitPerHour?: number;
}

export function createdWorlds(state: Record<string, unknown>): string[] {
  return (state[REGISTRY] as string[] | undefined) ?? [];
}

export async function createWorld(ctx: ScenarioContext, spec: WorldSpec): Promise<WorldCreated> {
  const scenario = spec.suffix === undefined ? ctx.scenario.slug : `${ctx.scenario.slug}-${spec.suffix}`;
  const world = (await ctx.qa("world.create", {
    runId: ctx.runId,
    scenario,
    startAtSim: spec.startAtSim,
    operations: [...spec.operations],
    ...(spec.rateLimitPerHour === undefined ? {} : { settings: { rateLimitPerHour: spec.rateLimitPerHour } }),
  })) as WorldCreated;
  const registered = createdWorlds(ctx.state);
  if (!registered.includes(world.clockId)) ctx.state[REGISTRY] = [...registered, world.clockId];
  ctx.state[`world:${spec.suffix ?? "main"}`] = world;
  ctx.note(spec.suffix === undefined ? "world" : `world-${spec.suffix}`, world.clockId);
  return world;
}

export function worldOf(ctx: ScenarioContext, suffix = "main"): WorldCreated {
  const world = ctx.state[`world:${suffix}`] as WorldCreated | undefined;
  if (world === undefined) throw new Error(`${ctx.scenario.id} has no world "${suffix}" yet`);
  return world;
}

/** The operation of key `key` in the world (`a` by default). */
export function opOf(ctx: ScenarioContext, key = "a", suffix = "main"): WorldOperationCreated {
  const operation = worldOf(ctx, suffix).operations.find((candidate) => candidate.key === key);
  if (operation === undefined) throw new Error(`${ctx.scenario.id} has no operation "${key}"`);
  return operation;
}

/** Settles the operation and moves the clock to its next pending timer (of `kind`, when given). */
export async function advanceToTimer(ctx: ScenarioContext, operationId: string, kind?: QaSnapshot["pendingTimers"][number]["kind"]): Promise<string> {
  const snapshot = await ctx.settled(operationId);
  const next = [...snapshot.pendingTimers].filter((timer) => kind === undefined || timer.kind === kind).sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim))[0];
  ensure(next !== undefined, `${operationId} has no pending ${kind ?? "timer"} to advance to`);
  await ctx.qa("clock.advanceTo", { clockId: snapshot.operation.clockId, to: next.dueAtSim });
  return next.dueAtSim;
}

export async function advanceTo(ctx: ScenarioContext, operationId: string, to: string): Promise<void> {
  const snapshot = await ctx.settled(operationId);
  await ctx.qa("clock.advanceTo", { clockId: snapshot.operation.clockId, to });
}

export async function advanceBy(ctx: ScenarioContext, operationId: string, byMinutes: number): Promise<void> {
  const snapshot = await ctx.settled(operationId);
  await ctx.qa("clock.advance", { clockId: snapshot.operation.clockId, byMinutes });
}

/** Waits for the first message of `filter` in the operation's timeline and returns the snapshot that has it. */
export async function awaitMessage(ctx: ScenarioContext, operationId: string, filter: MessageFilter, timeoutSec: number = WAITS.turnSec): Promise<QaSnapshot> {
  const what = `${filter.direction ?? ""} ${filter.channel ?? ""} ${String(filter.kind ?? "message")} ${String(filter.status ?? "")}`.replace(/\s+/g, " ").trim();
  return ctx.eventually(
    `${operationId}: ${what}`,
    async () => {
      const snapshot = await ctx.snapshot(operationId);
      return messages(snapshot, filter).length > 0 ? snapshot : undefined;
    },
    timeoutSec,
  );
}

/** Waits until `probe` holds on a fresh snapshot of the operation. */
export async function awaitState(ctx: ScenarioContext, operationId: string, what: string, probe: (snapshot: QaSnapshot) => boolean, timeoutSec: number = WAITS.turnSec): Promise<QaSnapshot> {
  return ctx.eventually(
    `${operationId}: ${what}`,
    async () => {
      const snapshot = await ctx.snapshot(operationId);
      return probe(snapshot) ? snapshot : undefined;
    },
    timeoutSec,
  );
}

/**
 * The Scheduler step (SMK/4, SC-01/2): one atomic `clock.unfreeze` leaves the next timer 120 real
 * seconds ahead with its schedule created; the real schedule fires it (`firedBy SCHEDULER`); the world
 * goes back to PAUSED.
 */
export async function schedulerProbe(ctx: ScenarioContext, operationId: string, expectedDueAtSim: string): Promise<void> {
  const snapshot = await ctx.settled(operationId);
  const clockId = snapshot.operation.clockId;
  try {
    const armed = (await ctx.qa("clock.unfreeze", { clockId, leadSec: 120 })) as { timerKey: string; dueAtSim: string };
    ctx.check(sameInstant(armed.dueAtSim, expectedDueAtSim), `the next timer is due at ${armed.dueAtSim}, expected ${expectedDueAtSim}`);
    ctx.note("scheduledTimer", armed.timerKey);
    await awaitState(ctx, operationId, `${armed.timerKey} fired by the Scheduler`, (fresh) => fresh.timers.some((timer) => `TIMER#${timer.kind}#${timer.timerId}` === armed.timerKey && timer.status === "FIRED" && timer.firedBy === "SCHEDULER"), WAITS.schedulerSec);
  } finally {
    await ctx.qa("clock.freeze", { clockId });
  }
}

export interface CleanupOutcome {
  readonly audits: Array<{ readonly clockId: string; readonly violations: number | null }>;
  readonly errors: string[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Per world: its policy audit (0 violations expected, kept for the report) and its destruction; one failure never skips the rest. */
export async function cleanupWorlds(ctx: ScenarioContext): Promise<CleanupOutcome> {
  const outcome: CleanupOutcome = { audits: [], errors: [] };
  for (const clockId of createdWorlds(ctx.state)) {
    let violations: number | null = null;
    try {
      const audit = (await ctx.qa("policyAudit.run", { clockId })) as { violations: unknown[] };
      violations = audit.violations.length;
    } catch (error) {
      outcome.errors.push(`policyAudit.run ${clockId}: ${messageOf(error)}`);
    }
    outcome.audits.push({ clockId, violations });
    try {
      await ctx.qa("world.destroy", { clockId });
    } catch (error) {
      outcome.errors.push(`world.destroy ${clockId}: ${messageOf(error)}`);
    }
  }
  return outcome;
}
