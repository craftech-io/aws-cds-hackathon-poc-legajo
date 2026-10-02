// The observations of a reading, applied to the document the reader recognized (FL-022, FL-023,
// FL-024, FL-040). One observation per operation, document and code (`obs-4471-PL-GROSS_WEIGHT_MISMATCH`):
//
//   - a code the document never had creates it OPEN, with the reader's field, expected and found
//     (masked: a reading is outside content) and the matrix default of the firm;
//   - `LOW_CONFIDENCE` is BLOCKING and its responsible is whoever sent the version (matrix row
//     `SENDER`, docs/architecture-integrations.md §5);
//   - a code the document already had follows the attempt rule of attempts.ts;
//   - an open observation the new reading no longer carries is RESOLVED by this version.
//
// Applying the same version twice changes nothing: an observation whose last version is this one was
// already applied (a retried event or a read resumed after a crash).
import { ConnectorError, DocType, type ObservationCode, observationId as observationIdOf } from "@legajo/shared";
import type { ReadingObservation } from "@legajo/reader-contract";
import type { Connector } from "../connector/connector";
import type { DocumentVersion, Observation, ReadingSnapshot } from "../domain/documents";
import { type ResponsibilityMatrix, matrixDefault } from "../domain/firms";
import type { Operation } from "../domain/operations";
import { maskText } from "../lib/mask";
import { recurrenceOf } from "./attempts";
import { observationAttemptsEscalation, operationRef } from "./escalation-rules";
import type { EscalationRequest } from "./ports";

/** Codes the reader may repeat in one reading; the first entry of each wins. */
function uniqueByCode(observations: readonly ReadingObservation[]): ReadingObservation[] {
  const byCode = new Map<ObservationCode, ReadingObservation>();
  for (const entry of observations) if (!byCode.has(entry.code)) byCode.set(entry.code, entry);
  return [...byCode.values()];
}

/** Statuses an absent code resolves: what still blocked or was being worked on. */
const RESOLVABLE: readonly Observation["status"][] = ["OPEN", "CORRECTION_REQUESTED", "ESCALATED"];

export interface ApplyObservationsInput {
  readonly operation: Operation;
  /** The filed version the reading belongs to (its type is the one the reader recognized). */
  readonly version: DocumentVersion;
  readonly reading: ReadingSnapshot;
  readonly matrix?: ResponsibilityMatrix;
  readonly atSim: string;
  readonly atReal: string;
}

export interface AppliedObservations {
  readonly created: readonly Observation[];
  readonly recurred: readonly Observation[];
  readonly resolved: readonly Observation[];
  /** `OBSERVATION_ATTEMPTS` escalations the recurrences reached. */
  readonly escalations: readonly EscalationRequest[];
}

const masked = (value: string | undefined): string | undefined => (value === undefined ? undefined : maskText(value));

function readerFacts(entry: ReadingObservation) {
  const against = DocType.safeParse(entry.againstDocType);
  const expected = masked(entry.expected);
  const found = masked(entry.found);
  return {
    severity: entry.code === "LOW_CONFIDENCE" ? ("BLOCKING" as const) : entry.severity,
    ...(entry.field === undefined ? {} : { field: entry.field }),
    ...(expected === undefined ? {} : { expected }),
    ...(found === undefined ? {} : { found }),
    ...(against.success ? { againstDocType: against.data } : {}),
  };
}

async function create(connector: Connector, input: ApplyObservationsInput, entry: ReadingObservation): Promise<Observation | undefined> {
  const { operation, version } = input;
  const lowConfidence = entry.code === "LOW_CONFIDENCE";
  const fromMatrix = input.matrix === undefined ? undefined : matrixDefault(input.matrix, version.docType, entry.code).responsible;
  try {
    return await connector.documents.createObservation({
      observationId: observationIdOf(operation.operationId, version.docType, entry.code),
      operationId: operation.operationId,
      clockId: operation.clockId,
      docType: version.docType,
      code: entry.code,
      ...readerFacts(entry),
      status: "OPEN",
      ...(lowConfidence ? { matrixDefault: "SENDER" as const, responsibleParty: version.source.party, matchesMatrix: true } : fromMatrix === undefined ? {} : { matrixDefault: fromMatrix }),
      firstDocVersionId: version.docVersionId,
      lastDocVersionId: version.docVersionId,
      created: { atSim: input.atSim, atReal: input.atReal, by: "SYSTEM" },
      ...(operation.runId === undefined ? {} : { runId: operation.runId }),
    });
  } catch (error) {
    // Created by a concurrent apply of the same reading: theirs is the one.
    if (error instanceof ConnectorError && error.code === "CONFLICT") return undefined;
    throw error;
  }
}

/** Applies the observations of a RECOGNIZED reading to the document of `version`. */
export async function applyObservations(connector: Connector, input: ApplyObservationsInput): Promise<AppliedObservations> {
  const { operation, version } = input;
  const existing = await connector.documents.listObservations(operation.operationId, { docType: version.docType });
  const byCode = new Map(existing.map((observation) => [observation.code, observation]));
  const entries = uniqueByCode(input.reading.observations ?? []);
  const stamp = { atSim: input.atSim, atReal: input.atReal, by: "SYSTEM" as const };
  const created: Observation[] = [];
  const recurred: Observation[] = [];
  const resolved: Observation[] = [];
  const escalations: EscalationRequest[] = [];

  for (const entry of entries) {
    const prior = byCode.get(entry.code);
    if (prior === undefined) {
      const fresh = await create(connector, input, entry);
      if (fresh !== undefined) created.push(fresh);
      continue;
    }
    if (prior.lastDocVersionId === version.docVersionId) continue;
    const recurrence = recurrenceOf(prior);
    if (recurrence.kind === "KEEP") continue;
    const facts = readerFacts(entry);
    const next = await connector.documents.transitionObservation({
      operationId: operation.operationId,
      observationId: prior.observationId,
      to: recurrence.to,
      docVersionId: version.docVersionId,
      countAttempt: recurrence.countAttempt,
      patch: facts,
      expectedVersion: prior.version,
      ...stamp,
    });
    recurred.push(next);
    const escalation = recurrence.escalate ? observationAttemptsEscalation(operationRef(operation), next, version.docVersionId, input.atSim) : undefined;
    if (escalation !== undefined) escalations.push(escalation);
  }

  const present = new Set(entries.map((entry) => entry.code));
  for (const observation of existing) {
    if (present.has(observation.code) || !RESOLVABLE.includes(observation.status) || observation.lastDocVersionId === version.docVersionId) continue;
    resolved.push(
      await connector.documents.transitionObservation({
        operationId: operation.operationId,
        observationId: observation.observationId,
        to: "RESOLVED",
        docVersionId: version.docVersionId,
        expectedVersion: observation.version,
        ...stamp,
      }),
    );
  }
  return { created, recurred, resolved, escalations };
}
