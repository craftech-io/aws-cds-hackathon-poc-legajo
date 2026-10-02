// A due `TIMER#FOLLOWUP_DUE#<followupId>` (docs/architecture.md §8, FL-027): the action `fire_timer`
// runs for it. When the documents it waited for already arrived (a newer version, or the document is
// `VALID`), or the dossier is complete, approved or released, it is skipped and no turn opens;
// otherwise an `AGENT_TURN(FOLLOWUP_DUE)` with the timer, whose id derives from the `TIMER` event.
import { z } from "zod";
import { DocType } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import type { Document } from "../../domain/documents";
import { skipReason } from "../../milestones/dossier";
import { firingEventId } from "../../milestones/deps";
import { type OperationEventSink, timerTurnEvent } from "../../timers/events";
import type { TimerAction } from "../../timers/fire";
import type { TurnEvent } from "../../worker/events";

const PendingPayload = z.object({ pending: z.array(z.object({ docType: DocType, version: z.number().int().nonnegative() })).default([]) }).loose();

export const FOLLOWUP_SKIP = { ARRIVED: "DOCUMENT_ARRIVED" } as const;

/** Whether every document the follow-up waited for arrived since it was scheduled. */
export function documentsArrived(payload: unknown, documents: readonly Pick<Document, "docType" | "status" | "currentVersion">[]): boolean {
  const parsed = PendingPayload.safeParse(payload ?? {});
  const pending = parsed.success ? parsed.data.pending : [];
  if (pending.length === 0) return false;
  return pending.every((waited) => {
    const document = documents.find((candidate) => candidate.docType === waited.docType);
    return document !== undefined && (document.status === "VALID" || document.currentVersion > waited.version);
  });
}

export interface FollowupDueDeps {
  readonly data: Pick<Connector, "operations" | "documents">;
  readonly sink: OperationEventSink<TurnEvent>;
}

export function followupDueAction(deps: FollowupDueDeps): TimerAction {
  return async (fired) => {
    const operation = await deps.data.operations.getOperation(fired.timer.operationId);
    const documents = await deps.data.documents.listDocuments(operation.operationId);
    const skip = skipReason(operation, documents);
    if (skip !== undefined) return { outcome: "SKIPPED", reason: skip };
    if (documentsArrived(fired.timer.payload, documents)) return { outcome: "SKIPPED", reason: FOLLOWUP_SKIP.ARRIVED };
    const turn = timerTurnEvent({ event: { ...fired.firing, eventId: firingEventId(fired) }, trigger: "FOLLOWUP_DUE" });
    await deps.sink.enqueue(turn);
    return { outcome: "FIRED", detail: { turnEventId: turn.eventId } };
  };
}
