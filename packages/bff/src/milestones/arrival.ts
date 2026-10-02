// The `ARRIVAL` milestone, at the ETA (FL-071, CONTEXT.md "Hito"): deterministic, no turn of the agent.
// The dossier that is not complete is at risk: the risk is recalculated with the firm's assumptions and
// the operation is marked "en riesgo". No new message when the operation was already escalated for the
// missing documents (`MISSING_AT_ETA_48H`, open or resolved); otherwise the same deterministic
// escalation the `ESCALATION` milestone opens (a world moved straight past ETA − 48 h still tells the
// firm). A complete dossier never gets here (fire.ts).
import type { Document } from "../domain/documents";
import type { Operation } from "../domain/operations";
import { riskOf } from "../escalations/report";
import type { FiredTimer, TimerActionResult } from "../timers/fire";
import { type MilestoneDeps, firingEventId } from "./deps";
import { escalateMissing } from "./escalation";

export async function arrivalMilestone(fired: FiredTimer, operation: Operation, documents: readonly Document[], deps: MilestoneDeps): Promise<TimerActionResult> {
  const { firing } = fired;
  const eventId = firingEventId(fired);
  const risk = await riskOf(deps, operation, firing.eventAtSim, documents);
  await deps.markAtRisk({ operationId: operation.operationId, firmId: operation.firmId, clockId: operation.clockId, risk, atSim: firing.eventAtSim, eventId, timerKey: firing.timerKey });
  const previous = await deps.data.operations.listEscalations(operation.operationId);
  const alreadyEscalated = previous.some((escalation) => escalation.reason === "MISSING_AT_ETA_48H");
  const base = { milestone: "ARRIVAL", atRisk: true, missing: [...risk.missing], daysAtRisk: { ...risk.daysAtRisk }, estimatedCostUsd: { ...risk.estimatedCostUsd } };
  if (alreadyEscalated) return { outcome: "FIRED", detail: { ...base, escalated: false } };
  const escalated = await escalateMissing(fired, operation, deps);
  return { outcome: "FIRED", detail: { ...base, escalated: true, escalationId: escalated.escalation.escalationId, firmEmail: escalated.firmEmail } };
}
