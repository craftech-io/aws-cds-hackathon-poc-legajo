// `intake_document` (docs/tool-catalog.md, docs/architecture.md §7 `INTAKE_DOCUMENT`): what the worker
// does with every PDF that reaches an operation, by email, WhatsApp or the upload link. No model:
//
//   1. the operation exists and is the event's (firm and world); the PDF is the one the event names
//      (SHA-256), starts with `%PDF-` and is at most 10 MB, or it is discarded and audited;
//   2. it is copied to `Documents` under a key built by code, in the slot it came in by (the upload
//      link's document, else the first document still pending), and read by the external reader with
//      `Idempotency-Key` = that version's id;
//   3. the reader decides the document: a RECOGNIZED reading files the version under its real type
//      (FL-025, a copy identical to the current one is recorded as a duplicate), applies observations,
//      attempts and the two-attempt rule (FL-022..FL-024, FL-040) and settles the document; UNRECOGNIZED
//      files it under `unrecognized/` and escalates to the firm (FL-026); a reader that does not answer
//      leaves the version RECEIVED with a `TIMER#READER_RETRY` (FL-096);
//   4. a PDF that came by WhatsApp or the console opens an `AGENT_TURN(DOCUMENT_READ)`; an email's turn
//      (`SUPPLIER_EMAIL`) and an upload's (`UPLOAD_COMPLETED`) already follow it in the FIFO.
//
// Retries are safe: `IDEMP#INTAKE_FILED#<eventId>` remembers the filed version, and a second run
// resumes from it instead of filing it again.
//
// An upload of the link follows the contract of public-web/links.ts: once its PDF was processed (or
// discarded) the intake records `IDEMP#UPLOAD_SCANNED#<key>` and closes `PENDING#<clockId>/SCAN#<sha8>`,
// so a "Listo" racing with `DocumentIntake` never leaves a pending scan that keeps the world busy.
import { z } from "zod";
import { ChannelError, DocType, DocVersionId, docVersionId, parseClockId } from "@legajo/shared";
import { IntakeDocumentEvent, type IntakeSource } from "../channels/adapter";
import { type Document, type DocumentVersion, MAX_DOCUMENT_BYTES, type VersionSource } from "../domain/documents";
import type { Operation } from "../domain/operations";
import { sha256Hex } from "../lib/crypto";
import { UPLOAD_MARK, markId, scanKeyOf } from "../public-web/links";
import { currentDuplicate, fileVersion, recordReaderFailure } from "./filing";
import { documentsPrefixOf, intakeKeys } from "./keys";
import type { IntakeDeps } from "./ports";
import { type ReadResult, effectiveReading, recordRead, requestReading, settleRecognized, settleUnrecognized } from "./reading";
import { documentReadTurn, scheduleReaderRetry } from "./retry";

/** `IDEMP#INTAKE_FILED#<eventId>`: the version an intake event filed (or the one it duplicated). */
export const INTAKE_FILED = "INTAKE_FILED";

const FiledMark = z.union([z.object({ docVersionId: DocVersionId }).strict(), z.object({ duplicateOf: DocVersionId }).strict()]);
type FiledMark = z.infer<typeof FiledMark>;

export type DiscardReason = "OPERATION_GONE" | "WORLD_MISMATCH" | "NOT_THE_FILE" | "NOT_PDF" | "TOO_LARGE";

export type IntakeOutcome = { readonly kind: "DISCARDED"; readonly reason: DiscardReason } | ReadResult;

/** Channels whose PDF has no turn of its own behind it in the FIFO. */
const OWN_TURN_CHANNELS: readonly IntakeSource["channel"][] = ["WHATSAPP", "CONSOLE"];

const PDF_MAGIC = "%PDF-";

function bytesVerdict(bytes: Uint8Array, sha256: string): DiscardReason | undefined {
  if (bytes.length > MAX_DOCUMENT_BYTES) return "TOO_LARGE";
  if (sha256Hex(bytes) !== sha256) return "NOT_THE_FILE";
  return Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString("latin1") === PDF_MAGIC ? undefined : "NOT_PDF";
}

/** The slot a PDF is filed under while the reader reads it: never a classification, only a place. */
export function slotOf(documents: readonly Pick<Document, "docType" | "status" | "requestedFrom">[], declared: DocType | undefined, party: IntakeSource["party"]): DocType {
  if (declared !== undefined) return declared;
  const pending = DocType.options.flatMap((docType) => documents.filter((document) => document.docType === docType && (document.status === "MISSING" || document.status === "WITH_OBSERVATION")));
  return (pending.find((document) => document.requestedFrom === party) ?? pending[0])?.docType ?? "COMMERCIAL_INVOICE";
}

/** The source as the version keeps it; an upload token is a bearer secret, so only its hash is kept. */
function versionSource(source: IntakeSource): VersionSource {
  return {
    party: source.party,
    channel: source.channel,
    ...(source.messageId === undefined ? {} : { messageId: source.messageId }),
    ...(source.contactId === undefined ? {} : { contactId: source.contactId }),
    ...(source.uploadToken === undefined ? {} : { uploadToken: sha256Hex(source.uploadToken) }),
  };
}

async function discard(deps: IntakeDeps, event: IntakeDocumentEvent, operation: Operation | undefined, reason: DiscardReason): Promise<IntakeOutcome> {
  deps.log.warn("intake.discarded", { reason, operationId: event.operationId, eventId: event.eventId });
  if (operation !== undefined) {
    await deps.connector.audit.record({
      firmId: operation.firmId,
      decision: "DENY",
      action: "INTAKE_DISCARDED",
      ruleIds: ["LAM-ATTACHMENT"],
      actor: "SYSTEM",
      reason,
      refs: { operationId: operation.operationId, eventId: event.eventId },
      clockId: operation.clockId,
      operationId: operation.operationId,
      atSim: event.eventAtSim,
      atReal: deps.wallClock().toISOString(),
      detail: { channel: event.source.channel, party: event.source.party },
    });
  }
  return { kind: "DISCARDED", reason };
}

async function claimFiled(deps: IntakeDeps, event: IntakeDocumentEvent, mark: FiledMark): Promise<void> {
  await deps.connector.runtime.claimIdempotency({ source: INTAKE_FILED, id: event.eventId, atReal: deps.wallClock().toISOString(), result: { ...mark } });
}

/** The version an intake event filed, for the worker's envelope of the turn that follows it. */
export async function filedVersionOf(deps: Pick<IntakeDeps, "connector">, intakeEventId: string): Promise<string | undefined> {
  const mark = FiledMark.safeParse((await deps.connector.runtime.getIdempotency(INTAKE_FILED, intakeEventId))?.result);
  if (!mark.success) return undefined;
  return "docVersionId" in mark.data ? mark.data.docVersionId : mark.data.duplicateOf;
}

async function followUp(deps: IntakeDeps, event: IntakeDocumentEvent, operation: Operation, result: IntakeOutcome): Promise<void> {
  if (result.kind === "DISCARDED" || result.kind === "UNAVAILABLE" || !OWN_TURN_CHANNELS.includes(event.source.channel)) return;
  await deps.events.enqueue(
    documentReadTurn({ operation, upstreamEventId: event.eventId, atSim: event.eventAtSim, intakeEventIds: [event.eventId], ...(event.source.messageId === undefined ? {} : { messageId: event.source.messageId }) }),
  );
}

async function firstReading(deps: IntakeDeps, event: IntakeDocumentEvent, operation: Operation, bytes: Uint8Array): Promise<ReadResult> {
  const { connector } = deps;
  const atSim = event.eventAtSim;
  const guestKind = parseClockId(operation.clockId)?.scope === "GUEST" ? (await connector.firms.findFirm(operation.firmId))?.guestKind : undefined;
  const prefix = documentsPrefixOf(operation, guestKind);
  const documents = await connector.documents.listDocuments(operation.operationId);
  const slot = slotOf(documents, event.declaredDocType, event.source.party);
  const slotDocument = await connector.documents.getDocument(operation.operationId, slot);
  const versionNo = slotDocument.currentVersion + 1;
  const provisionalId = docVersionId(operation.operationId, slot, versionNo);
  const stagingKey = intakeKeys.version(prefix, operation.operationId, slot, versionNo, event.sha256);
  await deps.documents.put(stagingKey, bytes);
  const base = { operation, sha256: event.sha256, sizeBytes: bytes.length, source: versionSource(event.source), receivedAtSim: atSim, receivedAtReal: deps.wallClock().toISOString() };

  const answer = await requestReading(deps, { docVersionId: provisionalId, sha256: event.sha256, key: stagingKey, clockId: operation.clockId, expectedDocType: slot });
  if (!answer.ok) {
    const filed = await fileVersion(connector, { ...base, docType: slot, versionNo, key: stagingKey, state: "RECEIVED", readerAttempts: 0, expectedDocumentVersion: slotDocument.version, ...(slotDocument.status === "MISSING" ? { document: { status: "RECEIVED" as const } } : {}) });
    await claimFiled(deps, event, { docVersionId: filed.docVersionId });
    return readerFailed(deps, operation, filed, atSim);
  }

  const read = { reading: answer.reading, readAtSim: atSim, readerAttempts: 1 };
  const effective = effectiveReading(answer.reading, operation);
  if (effective.kind === "UNRECOGNIZED") {
    const key = intakeKeys.unrecognized(prefix, operation.operationId, provisionalId);
    await deps.documents.put(key, bytes);
    await deps.documents.delete(stagingKey);
    const filed = await fileVersion(connector, { ...base, ...read, docType: slot, versionNo, key, state: "UNRECOGNIZED", expectedDocumentVersion: slotDocument.version });
    await claimFiled(deps, event, { docVersionId: filed.docVersionId });
    return settleUnrecognized(deps, operation, filed, effective.distrusted, atSim);
  }

  const { docType } = effective;
  const duplicate = await currentDuplicate(connector, operation.operationId, docType, event.sha256);
  if (duplicate !== undefined) {
    await deps.documents.delete(stagingKey);
    await claimFiled(deps, event, { duplicateOf: duplicate.docVersionId });
    await recordRead(deps, operation, duplicate, atSim, { readingStatus: "RECOGNIZED", duplicate: true, channelOfCopy: event.source.channel });
    return { kind: "DUPLICATE", version: duplicate };
  }
  const target = docType === slot ? slotDocument : await connector.documents.getDocument(operation.operationId, docType);
  const targetNo = target.currentVersion + 1;
  let key = stagingKey;
  if (docType !== slot) {
    key = intakeKeys.version(prefix, operation.operationId, docType, targetNo, event.sha256);
    await deps.documents.put(key, bytes);
    await deps.documents.delete(stagingKey);
  }
  const filed = await fileVersion(connector, { ...base, ...read, docType, versionNo: targetNo, key, state: "READ", expectedDocumentVersion: target.version });
  await claimFiled(deps, event, { docVersionId: filed.docVersionId });
  return settleRecognized(deps, operation, filed, answer.reading, atSim);
}

async function readerFailed(deps: IntakeDeps, operation: Operation, version: DocumentVersion, atSim: string): Promise<ReadResult> {
  const failure = await recordReaderFailure(deps, operation, version, atSim);
  await scheduleReaderRetry(deps.timers, operation, failure.version, failure.failures, atSim);
  await recordRead(deps, operation, failure.version, atSim, { readingStatus: "PENDING", failures: failure.failures });
  return { kind: "UNAVAILABLE", version: failure.version, failures: failure.failures, ...(failure.escalation === undefined ? {} : { escalation: failure.escalation }) };
}

/** A retried event whose version was already filed: finish what the first run left undone. */
async function resume(deps: IntakeDeps, event: IntakeDocumentEvent, operation: Operation, mark: FiledMark): Promise<IntakeOutcome> {
  const id = "docVersionId" in mark ? mark.docVersionId : mark.duplicateOf;
  const version = await deps.connector.documents.findVersion(id);
  if (version === undefined) return discard(deps, event, operation, "OPERATION_GONE");
  if ("duplicateOf" in mark) return { kind: "DUPLICATE", version };
  if (version.state === "READ" && version.reading !== undefined) return settleRecognized(deps, operation, version, version.reading, event.eventAtSim);
  if (version.state === "UNRECOGNIZED") return settleUnrecognized(deps, operation, version, false, event.eventAtSim);
  if (version.state === "RECEIVED" || version.state === "READER_UNAVAILABLE") {
    if (version.readerAttempts === 0) return readerFailed(deps, operation, version, event.eventAtSim);
    return { kind: "UNAVAILABLE", version, failures: version.readerAttempts };
  }
  // Classified or discarded since (by the reader on a retry, or by the firm): nothing left to finish.
  return { kind: "DUPLICATE", version };
}

/** An upload is done with: its scan mark is claimed and its pending scan closed (both idempotent). */
async function closeUploadScan(deps: IntakeDeps, event: IntakeDocumentEvent): Promise<void> {
  if (event.object.store !== "UPLOADS") return;
  const { key } = event.object;
  await deps.connector.runtime.claimIdempotency({ source: UPLOAD_MARK.scanned, id: markId.scanned(key), atReal: deps.wallClock().toISOString() });
  await deps.connector.world.closeScanPending(event.clockId, scanKeyOf(key));
}

/** Runs one `INTAKE_DOCUMENT` event of `OperationEvents.fifo` (the worker owns the queue and its idempotency). */
export async function intakeDocument(deps: IntakeDeps, raw: IntakeDocumentEvent): Promise<IntakeOutcome> {
  const event = IntakeDocumentEvent.parse(raw);
  const outcome = await intakeOf(deps, event);
  await closeUploadScan(deps, event);
  return outcome;
}

async function intakeOf(deps: IntakeDeps, event: IntakeDocumentEvent): Promise<IntakeOutcome> {
  const operation = await deps.connector.operations.findOperation(event.operationId);
  if (operation === undefined) return discard(deps, event, undefined, "OPERATION_GONE");
  if (operation.firmId !== event.firmId || operation.clockId !== event.clockId) return discard(deps, event, operation, "WORLD_MISMATCH");

  const mark = FiledMark.safeParse((await deps.connector.runtime.getIdempotency(INTAKE_FILED, event.eventId))?.result);
  let result: IntakeOutcome;
  if (mark.success) {
    result = await resume(deps, event, operation, mark.data);
  } else {
    let bytes: Uint8Array;
    try {
      bytes = await deps.sources.read(event.object, event.sha256);
    } catch (error) {
      if (error instanceof ChannelError && (error.code === "INVALID" || error.code === "PARSE_FAILED")) return discard(deps, event, operation, "NOT_THE_FILE");
      throw error;
    }
    const verdict = bytesVerdict(bytes, event.sha256);
    if (verdict !== undefined) return discard(deps, event, operation, verdict);
    result = await firstReading(deps, event, operation, bytes);
  }
  await followUp(deps, event, operation, result);
  deps.log.info("intake.done", { operationId: operation.operationId, eventId: event.eventId, outcome: result.kind, docVersionId: result.kind === "DISCARDED" ? undefined : result.version.docVersionId });
  return result;
}
