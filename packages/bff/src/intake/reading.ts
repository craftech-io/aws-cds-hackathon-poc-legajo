// One reading of the external reader and what it does to the dossier (ADR-0003, docs/tool-catalog.md
// `intake_document` and `read_document`). Shared by the intake of a new PDF, the `TIMER#READER_RETRY`
// of a version the reader could not read, and `read_document` on such a version:
//
//   - the reader is called with `Idempotency-Key = docVersionId` and a 5-minute GET of the version in
//     `Documents`; any failure after the client's own retries is `UNAVAILABLE`, never a reading;
//   - the type is the reader's, never the subject, the file name or the slot it came in by;
//   - a reading matched by the id embedded in the PDF (`EMBEDDED_ID`, something the sender controls) is
//     trusted only when it refers to this operation's invoice; otherwise it is treated as UNRECOGNIZED
//     and goes to the firm (reader-mock fallback finding of wave 1);
//   - a RECOGNIZED reading applies its observations, escalates what reached the attempt limit and
//     settles the document; an UNRECOGNIZED one escalates `UNRECOGNIZED_DOCUMENT` and moves nothing.
import type { DocType } from "@legajo/shared";
import type { Reading } from "@legajo/reader-contract";
import type { DocumentVersion } from "../domain/documents";
import type { Operation } from "../domain/operations";
import { ReaderError } from "../reader/errors";
import { settleDocument } from "./document-status";
import { operationRef, unrecognizedEscalation } from "./escalation-rules";
import { type AppliedObservations, applyObservations } from "./observations";
import type { EscalationOutcome, ReadingDeps } from "./ports";

/** What a reading means for this operation once the trust checks ran. */
export type EffectiveReading = { readonly kind: "RECOGNIZED"; readonly docType: DocType } | { readonly kind: "UNRECOGNIZED"; readonly distrusted: boolean };

/** An `EMBEDDED_ID` match names some synthetic document; it counts only if it is about this invoice. */
function refersToOperation(reading: Reading, operation: Pick<Operation, "invoiceNumber">): boolean {
  if (reading.fields?.invoiceNumber === operation.invoiceNumber) return true;
  return (reading.observations ?? []).some((entry) => entry.code === "INVOICE_NUMBER_MISMATCH" && entry.expected === operation.invoiceNumber);
}

export function effectiveReading(reading: Reading, operation: Pick<Operation, "invoiceNumber">): EffectiveReading {
  if (reading.status !== "RECOGNIZED" || reading.docType === undefined) return { kind: "UNRECOGNIZED", distrusted: false };
  if (reading.matchedBy === "EMBEDDED_ID" && !refersToOperation(reading, operation)) return { kind: "UNRECOGNIZED", distrusted: true };
  return { kind: "RECOGNIZED", docType: reading.docType };
}

export interface ReadingRequest {
  /** The `Idempotency-Key`: the version being read. */
  readonly docVersionId: string;
  readonly sha256: string;
  /** Its `Documents` key, pre-signed for the reader. */
  readonly key: string;
  readonly clockId: string;
  /** The slot it came in by; only a hint, the reader decides. */
  readonly expectedDocType: DocType;
}

export type ReaderAnswer = { readonly ok: true; readonly reading: Reading } | { readonly ok: false; readonly error: ReaderError };

export async function requestReading(deps: Pick<ReadingDeps, "reader" | "documents" | "log">, request: ReadingRequest): Promise<ReaderAnswer> {
  try {
    const sourceUrl = await deps.documents.sourceUrl(request.key);
    const reading = await deps.reader.createReading({ docVersionId: request.docVersionId, sha256: request.sha256, sourceUrl, clockId: request.clockId, hints: { expectedDocType: request.expectedDocType } });
    return { ok: true, reading };
  } catch (error) {
    if (!(error instanceof ReaderError)) throw error;
    deps.log.warn("intake.reader_failed", { docVersionId: request.docVersionId, code: error.code, attempts: error.details.attempts });
    return { ok: false, error };
  }
}

export type ReadResult =
  | { readonly kind: "READ"; readonly version: DocumentVersion; readonly observations: AppliedObservations; readonly escalations: readonly EscalationOutcome[] }
  | { readonly kind: "UNRECOGNIZED"; readonly version: DocumentVersion; readonly distrusted: boolean; readonly escalation: EscalationOutcome }
  | { readonly kind: "DUPLICATE"; readonly version: DocumentVersion }
  | { readonly kind: "UNAVAILABLE"; readonly version: DocumentVersion; readonly failures: number; readonly escalation?: EscalationOutcome };

/** A RECOGNIZED version that is already filed: observations, attempt escalations and the document's status. */
export async function settleRecognized(deps: ReadingDeps, operation: Operation, version: DocumentVersion, reading: Reading, atSim: string): Promise<ReadResult> {
  const matrix = deps.matrixOf === undefined ? undefined : await deps.matrixOf(operation.firmId);
  const atReal = deps.wallClock().toISOString();
  const observations = await applyObservations(deps.connector, { operation, version, reading, ...(matrix === undefined ? {} : { matrix }), atSim, atReal });
  const escalations: EscalationOutcome[] = [];
  for (const request of observations.escalations) {
    const outcome = await deps.escalate(request);
    escalations.push(outcome);
    if (request.observationId !== undefined) await deps.connector.documents.updateObservation(operation.operationId, request.observationId, { escalationId: outcome.escalationId });
  }
  await settleDocument(deps.connector, operation.operationId, version.docType);
  await recordRead(deps, operation, version, atSim, { readingStatus: "RECOGNIZED", observations: (reading.observations ?? []).length, escalated: escalations.length });
  return { kind: "READ", version, observations, escalations };
}

/** A filed version the reader did not recognize (or whose embedded id is foreign): to the firm. */
export async function settleUnrecognized(deps: ReadingDeps, operation: Operation, version: DocumentVersion, distrusted: boolean, atSim: string): Promise<ReadResult> {
  const escalation = await deps.escalate(unrecognizedEscalation(operationRef(operation), version, atSim));
  await settleDocument(deps.connector, operation.operationId, version.docType);
  await recordRead(deps, operation, version, atSim, { readingStatus: "UNRECOGNIZED", ...(distrusted ? { reason: "EMBEDDED_ID_FOREIGN" } : {}) });
  return { kind: "UNRECOGNIZED", version, distrusted, escalation };
}

/** `ACTION DOCUMENT_READ` (docs/tool-catalog.md `intake_document`): what was read, never the PDF's contents. */
export async function recordRead(deps: Pick<ReadingDeps, "connector" | "wallClock">, operation: Operation, version: DocumentVersion, atSim: string, detail: Readonly<Record<string, unknown>>): Promise<void> {
  await deps.connector.audit.record({
    firmId: operation.firmId,
    decision: "ACTION",
    action: "DOCUMENT_READ",
    actor: "SYSTEM",
    refs: { operationId: operation.operationId, docVersionId: version.docVersionId },
    clockId: operation.clockId,
    operationId: operation.operationId,
    atSim,
    atReal: deps.wallClock().toISOString(),
    detail: { docType: version.docType, versionNo: version.versionNo, channel: version.source.channel, party: version.source.party, ...detail },
  });
}
