// Busy worlds (`WORLD_BUSY`, docs/architecture.md §7-§8, CONTEXT.md "Mundo ocupado"). A world is quiet
// when its `WORLDSTATE#<clockId>.inFlight` is empty, no SCHEDULED timer of its clock is due
// (`dueAtSim ≤ simNow`) and `PENDING#<clockId>` has no open mail or scan. The console's procedures
// that move time or inject events (`clock.advance*`, `fireMilestone`, `moveEta`, `emitDispatchStatus`)
// change nothing in a busy world: they answer the pending list. After five real minutes of the same
// wait the console may send `force: true` ("Avanzar igual"), which is accepted only when the oldest
// pending is older than that, and audited `ACTION CLOCK_FORCED`. The `QaDriver` never goes through
// this gate: it waits with `op.settle`.
import { ToolError, operationNumberOf, type PendingKind } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import type { Actor } from "../domain/common";
import { timerKeyOf } from "../domain/timers";
import { simNowOf } from "../lib/clock";
import { timerEventId } from "../timers/events";

/** "Avanzar igual" appears, and `force` is accepted, after the oldest pending waited this long. */
export const FORCE_AFTER_MS = 5 * 60_000;

/** `reason` of a refusal of a busy world (the console maps it to its `WORLD_BUSY` answer). */
export const WORLD_BUSY = "WORLD_BUSY";

export interface WorldPending {
  readonly kind: PendingKind;
  readonly operationNumber?: string;
  /** Event id, what a mail waits for, the bucket of a scan or the kind of a due timer: never an address or a key. */
  readonly detail: string;
  /** Real instant the wait started (the last change of the in-flight set for events: never overstated). */
  readonly sinceReal: string;
}

/** A busy world's refusal: nothing changed, here is what it waits for. */
export class WorldBusyError extends ToolError {
  constructor(
    readonly pending: readonly WorldPending[],
    readonly forceAllowedAtReal: string,
  ) {
    super("CONFLICT", "the world is busy: wait until it is quiet", WORLD_BUSY);
  }
}

function numberOf(operationId: string): string | undefined {
  try {
    return operationNumberOf(operationId);
  } catch {
    return undefined;
  }
}

function withNumber(operationId: string | undefined): { readonly operationNumber?: string } {
  const operationNumber = operationId === undefined ? undefined : numberOf(operationId);
  return operationNumber === undefined ? {} : { operationNumber };
}

/** What the world waits for right now; stale pending mails and scans are no longer waited for. */
export async function worldPending(data: Pick<Connector, "world" | "timers">, clockId: string, realNow: Date): Promise<WorldPending[]> {
  const [world, pending, clock] = await Promise.all([data.world.getWorldState(clockId), data.world.listPending(clockId), data.world.getClock(clockId)]);
  const now = realNow.getTime();
  const simNow = simNowOf(clock, now).toISOString();
  const due = await data.timers.listDueTimers(clockId, simNow);
  const events = (world?.inFlight ?? []).map((entry): WorldPending => {
    const separator = entry.indexOf("#");
    const operationId = separator === -1 ? undefined : entry.slice(0, separator);
    return { kind: "EVENT", ...withNumber(operationId), detail: separator === -1 ? entry : entry.slice(separator + 1), sinceReal: world?.updatedAt ?? realNow.toISOString() };
  });
  const mails = pending.mails.filter((mail) => Date.parse(mail.staleAtReal) > now).map((mail): WorldPending => ({ kind: "MAIL", ...withNumber(mail.operationId), detail: mail.awaiting, sinceReal: mail.sentAtReal }));
  const scans = pending.scans.filter((scan) => Date.parse(scan.staleAtReal) > now).map((scan): WorldPending => ({ kind: "SCAN", ...withNumber(scan.operationId), detail: scan.bucket, sinceReal: scan.createdAtReal }));
  // A due timer already on its way is the in-flight event above; one that is not (its dispatch was
  // lost) waits since the clock reached it or since it was written, whichever is later.
  const inFlight = new Set(events.map((event) => event.detail));
  const timers = due
    .filter((timer) => !inFlight.has(timerEventId(timer.operationId, timerKeyOf(timer.kind, timer.timerId), timer.dueAtSim, timer.version, timer.worldEpoch)))
    .map((timer): WorldPending => ({ kind: "EVENT", ...withNumber(timer.operationId), detail: `TIMER ${timer.kind}`, sinceReal: new Date(Math.max(Date.parse(clock.updatedAt), Date.parse(timer.updatedAt))).toISOString() }));
  return [...events, ...mails, ...scans, ...timers];
}

export interface GateInput {
  readonly clockId: string;
  readonly firmId: string;
  /** "Avanzar igual": accepted only once the oldest pending waited `FORCE_AFTER_MS`. */
  readonly force?: boolean;
  readonly actor: Actor;
  readonly correlationId?: string;
}

export interface GateDeps {
  readonly data: Pick<Connector, "world" | "timers" | "audit">;
  readonly realClock: () => Date;
}

/**
 * The console's gate before a move or an injection: returns when the world is quiet, or when `force`
 * is accepted (and audited); throws `WorldBusyError` otherwise. Answers whether it was forced.
 */
export async function assertWorldQuiet(input: GateInput, deps: GateDeps): Promise<{ readonly forced: boolean }> {
  const realNow = deps.realClock();
  const pending = await worldPending(deps.data, input.clockId, realNow);
  if (pending.length === 0) return { forced: false };
  const oldest = Math.min(...pending.map((item) => Date.parse(item.sinceReal)));
  const forceAllowedAtReal = new Date(oldest + FORCE_AFTER_MS);
  if (input.force !== true || realNow.getTime() < forceAllowedAtReal.getTime()) throw new WorldBusyError(pending, forceAllowedAtReal.toISOString());
  const clock = await deps.data.world.getClock(input.clockId);
  await deps.data.audit.record({
    firmId: input.firmId,
    decision: "ACTION",
    action: "CLOCK_FORCED",
    actor: input.actor,
    clockId: input.clockId,
    atSim: simNowOf(clock, realNow.getTime()).toISOString(),
    atReal: realNow.toISOString(),
    reason: "the console moved a world that had been busy for five minutes",
    detail: { pending: pending.map((item) => ({ kind: item.kind, ...(item.operationNumber === undefined ? {} : { operationNumber: item.operationNumber }), detail: item.detail, sinceReal: item.sinceReal })) },
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });
  return { forced: true };
}
