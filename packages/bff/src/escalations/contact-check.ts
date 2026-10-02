// `TIMER#CONTACT_CHECK` (docs/architecture.md §8, docs/design-brief.md §5.8): one simulated day after a
// permanent bounce, the operation's supplier must have a contact that was ACTIVE and confirmed at the
// firing's simulated instant (the rule is intake/escalation-rules.ts `noValidContactEscalation`). If it
// does not, the deterministic escalation `NO_VALID_CONTACT` (with its email to the firm); if it does,
// the timer is skipped. A dossier already complete or approved needs no contact.
import { noValidContactEscalation, operationRef } from "../intake/escalation-rules";
import type { FiredTimer, TimerActionResult } from "../timers/fire";
import { escalate } from "./escalate";
import type { EscalationDeps } from "./ports";

export async function contactCheckAction(fired: FiredTimer, deps: EscalationDeps): Promise<TimerActionResult> {
  const operation = await deps.data.operations.getOperation(fired.timer.operationId);
  if (operation.dossierStatus === "APPROVED" || operation.dossierStatus === "READY_FOR_REVIEW") return { outcome: "SKIPPED", reason: "DOSSIER_COMPLETE" };
  const contacts = await deps.data.parties.listContacts(operation.supplierId);
  const request = noValidContactEscalation(operationRef(operation), contacts, fired.firing.eventAtSim);
  if (request === undefined) return { outcome: "SKIPPED", reason: "CONTACT_CONFIRMED" };
  const escalated = await escalate(
    {
      operation,
      reason: request.reason,
      summary: request.summary,
      actor: "SYSTEM",
      atSim: fired.firing.eventAtSim,
      correlationId: fired.firing.correlationId ?? fired.firing.eventId ?? fired.timer.operationId,
      refs: { timerKey: `TIMER#CONTACT_CHECK#${fired.timer.timerId}`, ...(fired.firing.eventId === undefined ? {} : { eventId: fired.firing.eventId }) },
    },
    deps,
  );
  return { outcome: "FIRED", detail: { escalationId: escalated.escalation.escalationId, created: escalated.created, firmEmail: escalated.firmEmail } };
}
