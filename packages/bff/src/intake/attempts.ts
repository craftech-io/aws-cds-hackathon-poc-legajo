// Attempts of an observation and the two-attempt rule (CONTEXT.md "Intento", FL-022, FL-024):
//
//   - every correction request of an observation counts one attempt and leaves it CORRECTION_REQUESTED
//     (`recordCorrectionRequest`, called when a CORRECTION_REQUEST naming it goes out);
//   - a new version that comes back with the same observation after a request is a failed attempt: it
//     counts one more and, at `ATTEMPT_LIMIT`, the observation is ESCALATED (OBSERVATION_ATTEMPTS) and
//     the agent stops asking for it; below the limit it goes back to OPEN for a new request;
//   - the same observation in a version nobody asked for (still OPEN) counts nothing;
//   - a resolved observation that shows up again reopens; a waived one stays waived.
//
// `recurrenceOf` is pure; the intake applies its answer in one conditional write per observation.
import type { ObservationStatus } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import type { HistoryStamp } from "../domain/common";
import type { Observation } from "../domain/documents";
import { ATTEMPT_LIMIT } from "./escalation-rules";

export type Recurrence =
  | { readonly kind: "KEEP" }
  | { readonly kind: "TRANSITION"; readonly to: ObservationStatus; readonly countAttempt: boolean; readonly escalate: boolean };

/** What a new version carrying the same observation does to it. */
export function recurrenceOf(observation: Pick<Observation, "status" | "attempts">): Recurrence {
  switch (observation.status) {
    case "CORRECTION_REQUESTED": {
      const attempts = observation.attempts + 1;
      const escalate = attempts >= ATTEMPT_LIMIT;
      return { kind: "TRANSITION", to: escalate ? "ESCALATED" : "OPEN", countAttempt: true, escalate };
    }
    case "OPEN":
    case "ESCALATED":
      return { kind: "TRANSITION", to: observation.status, countAttempt: false, escalate: false };
    case "RESOLVED":
      return { kind: "TRANSITION", to: "OPEN", countAttempt: false, escalate: false };
    case "WAIVED_BY_BROKER":
      return { kind: "KEEP" };
  }
}

/** Statuses a correction request moves to CORRECTION_REQUESTED (an escalated one is the firm's now). */
const REQUESTABLE: readonly ObservationStatus[] = ["OPEN"];

export interface CorrectionRequest extends HistoryStamp {
  readonly operationId: string;
  readonly observationIds: readonly string[];
}

/**
 * A CORRECTION_REQUEST naming these observations went out: each OPEN one counts its attempt and
 * becomes CORRECTION_REQUESTED. A repeated request of one already requested counts nothing.
 */
export async function recordCorrectionRequest(connector: Pick<Connector, "documents">, request: CorrectionRequest): Promise<Observation[]> {
  const updated: Observation[] = [];
  for (const observationId of new Set(request.observationIds)) {
    const observation = await connector.documents.findObservation(request.operationId, observationId);
    if (observation === undefined || !REQUESTABLE.includes(observation.status)) continue;
    updated.push(
      await connector.documents.transitionObservation({
        operationId: request.operationId,
        observationId,
        to: "CORRECTION_REQUESTED",
        countAttempt: true,
        atSim: request.atSim,
        by: request.by,
        expectedVersion: observation.version,
        ...(request.atReal === undefined ? {} : { atReal: request.atReal }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      }),
    );
  }
  return updated;
}
