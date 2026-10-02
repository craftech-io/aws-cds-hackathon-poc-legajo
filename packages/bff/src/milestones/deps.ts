// What the milestone actions share: the escalation ports, the producer of the turns they open and the
// at-risk mark of `ARRIVAL`, plus the `TIMER` event id a firing belongs to.
import type { Connector } from "../connector/connector";
import type { DelayRisk } from "../agent-tools/followups/risk";
import type { EscalationDeps } from "../escalations/ports";
import { type OperationEventSink, timerEventId } from "../timers/events";
import type { FiredTimer } from "../timers/fire";
import type { TurnEvent } from "../worker/events";

/** The at-risk mark of an operation whose dossier is incomplete at its ETA (FL-071). */
export interface AtRiskMark {
  readonly operationId: string;
  readonly firmId: string;
  readonly clockId: string;
  readonly risk: DelayRisk;
  readonly atSim: string;
  /** The `TIMER` event of the `ARRIVAL` milestone: the mark is written once per firing. */
  readonly eventId: string;
  readonly timerKey: string;
}

export type AtRiskMarker = (mark: AtRiskMark) => Promise<void>;

/** `AT_RISK` audit decision (`ACTION`, once per firing) with the recalculated risk. */
export const AT_RISK_ACTION = "AT_RISK";

/** FL-071: `Operations/META.atRisk = true` (the console's "en riesgo") and the risk in the audit. */
export function markAtRisk(data: Pick<Connector, "operations" | "audit">, wallClock: () => Date): AtRiskMarker {
  return async (mark) => {
    const operation = await data.operations.getOperation(mark.operationId);
    if (operation.atRisk !== true) await data.operations.updateOperation(mark.operationId, { atRisk: true }, operation.version);
    await data.audit.recordOnce(`${AT_RISK_ACTION}#${mark.operationId}#${mark.eventId}`, {
      firmId: mark.firmId,
      decision: "ACTION",
      action: AT_RISK_ACTION,
      actor: "SYSTEM",
      clockId: mark.clockId,
      operationId: mark.operationId,
      refs: { operationId: mark.operationId, eventId: mark.eventId, timerKey: mark.timerKey },
      atSim: mark.atSim,
      atReal: wallClock().toISOString(),
      reason: "the dossier is incomplete at the ETA",
      detail: {
        atRisk: true,
        missing: [...mark.risk.missing],
        hoursToEta: mark.risk.hoursToEta,
        daysAtRisk: { ...mark.risk.daysAtRisk },
        estimatedCostUsd: { ...mark.risk.estimatedCostUsd },
        text: mark.risk.text,
      },
    });
  };
}

export interface MilestoneDeps extends EscalationDeps {
  /** Producer of the turn a milestone opens (the worker's `ctx.sink`). */
  readonly sink: OperationEventSink<TurnEvent>;
  readonly markAtRisk: AtRiskMarker;
}

/** The `TIMER` event id of the firing (the turn's id derives from it). */
export function firingEventId(fired: FiredTimer): string {
  const { firing } = fired;
  return firing.eventId ?? timerEventId(firing.operationId, firing.timerKey, firing.dueAtSim, firing.version);
}
