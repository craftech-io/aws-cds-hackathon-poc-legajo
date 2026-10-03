// `Operations/TIMER#<kind>#<timerId>` (ADR-0004, docs/architecture.md §8): everything that has to
// happen at a simulated hour. While SCHEDULED it is in `GSI3 CLOCK#<clockId>` by `dueAtSim`, which
// is how the paused clock of a world finds what is due; at most one EventBridge schedule each.
import { z } from "zod";
import { ClockId, MilestoneName, OperationId, TimerFiredBy, TimerKind, TimerStatus } from "@legajo/shared";
import { JsonObject, ZonedInstant, defineEntity } from "./common";

export const TimerId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "expected a timer id of letters, digits, '-' or '_'");
export type TimerId = z.infer<typeof TimerId>;

export const Timer = defineEntity({
  operationId: OperationId,
  clockId: ClockId,
  /** World epoch the timer belongs to (the clock's at creation): its TIMER event id changes with every reset. */
  worldEpoch: z.number().int().min(1).default(1),
  kind: TimerKind,
  /** Milestone name for `MILESTONE`, a generated id for the rest. */
  timerId: TimerId,
  /** Canonical UTC (it is the range key of GSI3). */
  dueAtSim: ZonedInstant,
  status: TimerStatus,
  firedBy: TimerFiredBy.optional(),
  firedAtSim: ZonedInstant.optional(),
  /** `tm-<w>-<timerId>` while a real schedule exists (worlds in RUNNING only). */
  scheduleName: z.string().min(1).max(64).optional(),
  /** Why it is pending, skipped or cancelled (`DOSSIER_COMPLETE`, `CP-HOURS-SUPPLIER`, …). */
  reason: z.string().max(200).optional(),
  payload: JsonObject.default({}),
}).refine((timer) => timer.kind !== "MILESTONE" || MilestoneName.safeParse(timer.timerId).success, "a milestone timer is named after its milestone");
export type Timer = z.output<typeof Timer>;

/** Statuses a SCHEDULED timer can leave to; nothing leaves a final status. */
export const TIMER_FINAL_STATUSES: readonly TimerStatus[] = ["FIRED", "SKIPPED", "CANCELLED"];

/** `TIMER#<kind>#<timerId>`: the sort key, and the `timerKey` the schedules and the console carry. */
export function timerKeyOf(kind: TimerKind, timerId: string): string {
  return `TIMER#${TimerKind.parse(kind)}#${TimerId.parse(timerId)}`;
}

export function parseTimerKey(timerKey: string): { kind: TimerKind; timerId: string } | undefined {
  const match = /^TIMER#([A-Z_]+)#([A-Za-z0-9_-]{1,64})$/.exec(timerKey);
  const kind = TimerKind.safeParse(match?.[1]);
  return match && kind.success ? { kind: kind.data, timerId: match[2] ?? "" } : undefined;
}
