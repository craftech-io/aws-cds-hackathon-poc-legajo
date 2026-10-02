// The `ESCALATION` milestone, ETA − 48 h (FL-066, docs/design-brief.md §5.8): deterministic, no turn of
// the agent. With documents still missing, the escalation `MISSING_AT_ETA_48H` with the dossier, what
// was tried, who owes what and the labelled risk, its email to the firm's mailbox from `avisos@` (the
// email to the firm is never deferred) and `legajo_escalado` to the importer through the pipeline
// (`CP-HOURS-AR` may defer it to the next opening). A complete dossier never gets here (fire.ts).
import { labelsEsAR } from "../copy/es-AR";
import type { Operation } from "../domain/operations";
import { type Escalated, escalate } from "../escalations/escalate";
import type { FiredTimer, TimerActionResult } from "../timers/fire";
import { type MilestoneDeps, firingEventId } from "./deps";

/** `MISSING_AT_ETA_48H` from a milestone: deterministic, the firm's email and `legajo_escalado`. */
export async function escalateMissing(fired: FiredTimer, operation: Operation, deps: MilestoneDeps): Promise<Escalated> {
  const { firing } = fired;
  const eventId = firingEventId(fired);
  return escalate(
    {
      operation,
      reason: "MISSING_AT_ETA_48H",
      summary: labelsEsAR.escalationReason.MISSING_AT_ETA_48H,
      notifyImporter: true,
      actor: "SYSTEM",
      atSim: firing.eventAtSim,
      trigger: "MILESTONE",
      correlationId: firing.correlationId ?? eventId,
      refs: { eventId, timerKey: firing.timerKey },
    },
    deps,
  );
}

export async function escalationMilestone(fired: FiredTimer, operation: Operation, deps: MilestoneDeps): Promise<TimerActionResult> {
  const escalated = await escalateMissing(fired, operation, deps);
  return {
    outcome: "FIRED",
    detail: {
      milestone: "ESCALATION",
      escalationId: escalated.escalation.escalationId,
      created: escalated.created,
      firmEmail: escalated.firmEmail,
      ...(escalated.importerNotice === undefined ? {} : { importerNotice: escalated.importerNotice }),
    },
  };
}
