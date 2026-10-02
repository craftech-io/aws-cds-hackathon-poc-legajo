// The five milestones of an operation (CONTEXT.md "Hito", docs/architecture.md §8), relative to its
// current ETA and in Argentina's time zone:
//
//   DOCS_REQUEST     ETA − 7 days, 10:00   first request to the importer
//   FOLLOWUP         ETA − 5 days, 10:00   reminder
//   FOLLOWUP_FINAL   ETA − 3 days, 10:00   last reminder
//   ESCALATION       ETA − 48 h            deterministic escalation if documents are missing
//   ARRIVAL          ETA                   the dossier that is not complete is at risk
//
// `schedule_milestones` (worker, `create_operation`): one `TIMER#MILESTONE#<name>` each, with its real
// schedule when the world runs. A milestone already in the past when the operation is created is never
// left SCHEDULED: it is dispatched once, in order (`firedBy CLOCK`), like the clock does with whatever
// falls due. Idempotent: a milestone that already exists is left as it is.
import { ConnectorError, MilestoneName } from "@legajo/shared";
import { timerKeyOf } from "../domain/timers";
import type { Operation } from "../domain/operations";
import { simNowOf } from "../lib/clock";
import { ARGENTINA_TIME_ZONE, atLocalTime, toZonedIso } from "../services/business-hours";
import { type ArmedTimer, type TimerDeps, armTimer } from "../timers/timers";
import type { Connector } from "../connector/connector";

const HOUR_MS = 60 * 60_000;

/** The instant of each milestone for an ETA, as ISO with Argentina's offset. */
export function milestoneDueTimes(eta: string): Readonly<Record<MilestoneName, string>> {
  const at = new Date(Date.parse(eta));
  if (Number.isNaN(at.getTime())) throw new RangeError(`invalid ETA ${eta}`);
  const zoned = (instant: Date) => toZonedIso(instant, ARGENTINA_TIME_ZONE);
  return {
    DOCS_REQUEST: zoned(atLocalTime(at, -7, "10:00", ARGENTINA_TIME_ZONE)),
    FOLLOWUP: zoned(atLocalTime(at, -5, "10:00", ARGENTINA_TIME_ZONE)),
    FOLLOWUP_FINAL: zoned(atLocalTime(at, -3, "10:00", ARGENTINA_TIME_ZONE)),
    ESCALATION: zoned(new Date(at.getTime() - 48 * HOUR_MS)),
    ARRIVAL: zoned(at),
  };
}

export interface MilestoneDeps extends TimerDeps {
  readonly data: Pick<Connector, "timers" | "world" | "audit">;
}

export interface ScheduledMilestones {
  /** Created SCHEDULED (with a schedule if the world runs). */
  readonly scheduled: readonly MilestoneName[];
  /** Created already due and dispatched once. */
  readonly dispatched: readonly MilestoneName[];
  /** Already there: left as they were. */
  readonly existing: readonly MilestoneName[];
}

/** `schedule_milestones` of a new operation. */
export async function scheduleMilestones(input: { readonly operation: Operation; readonly correlationId?: string }, deps: MilestoneDeps): Promise<ScheduledMilestones> {
  const { operation } = input;
  const clock = await deps.data.world.getClock(operation.clockId);
  const realNow = deps.realClock();
  const simNow = simNowOf(clock, realNow.getTime()).getTime();
  const due = milestoneDueTimes(operation.eta);
  const scheduled: MilestoneName[] = [];
  const dispatched: MilestoneName[] = [];
  const existing: MilestoneName[] = [];
  for (const name of MilestoneName.options) {
    const armed = await armMilestone(operation, name, due[name], deps);
    if (armed === undefined) {
      existing.push(name);
      continue;
    }
    if (Date.parse(armed.timer.dueAtSim) > simNow) {
      scheduled.push(name);
      continue;
    }
    // A RUNNING world already dispatched it directly; a paused one leaves it to us, like the clock would.
    if (armed.schedule !== "DISPATCHED") await deps.dispatcher.dispatch({ timer: armed.timer, firmId: operation.firmId, firedBy: "CLOCK", eventAtSim: armed.timer.dueAtSim });
    dispatched.push(name);
  }
  await deps.data.audit.record({
    firmId: operation.firmId,
    decision: "ACTION",
    action: "MILESTONES_SCHEDULED",
    actor: "SYSTEM",
    clockId: operation.clockId,
    operationId: operation.operationId,
    refs: { operationId: operation.operationId },
    atSim: new Date(simNow).toISOString(),
    atReal: realNow.toISOString(),
    detail: { eta: operation.eta, dueAtSim: { ...due }, scheduled, dispatched, existing, timerKeys: MilestoneName.options.map((name) => timerKeyOf("MILESTONE", name)) },
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });
  return { scheduled, dispatched, existing };
}

/** The milestone armed, or `undefined` when it already existed. */
async function armMilestone(operation: Operation, name: MilestoneName, dueAtSim: string, deps: MilestoneDeps): Promise<ArmedTimer | undefined> {
  try {
    return await armTimer({ operationId: operation.operationId, clockId: operation.clockId, kind: "MILESTONE", timerId: name, dueAtSim, reason: "MILESTONE" }, deps);
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") return undefined;
    throw error;
  }
}
