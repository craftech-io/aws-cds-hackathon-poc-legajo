// Reading a version that is already filed and still waiting for its reading (RECEIVED or
// READER_UNAVAILABLE): what `TIMER#READER_RETRY` does and what `read_document` does when the model
// asks for such a version (docs/tool-catalog.md). The `Idempotency-Key` is the version's own id.
//
// When the reader says the file is another of the three documents, the version is kept as
// CLASSIFIED (by the reader, `classifiedBy SYSTEM`) and a version of the real document is filed next
// to it pointing at the same object: `ToolDocuments` only reads `Documents`, and the object of a
// world is removed by its prefix whichever version points at it.
import type { Connector } from "../connector/connector";
import type { DocumentVersion } from "../domain/documents";
import type { Operation } from "../domain/operations";
import { isPendingVersion, settleDocument } from "./document-status";
import { currentDuplicate, fileVersion, recordReaderFailure } from "./filing";
import type { ReadingDeps } from "./ports";
import { type ReadResult, effectiveReading, recordRead, requestReading, settleRecognized, settleUnrecognized } from "./reading";

/** Reads a pending version; a failure counts on it (and escalates at the third). */
export async function readPendingVersion(deps: ReadingDeps, operation: Operation, version: DocumentVersion, atSim: string): Promise<ReadResult> {
  const answer = await requestReading(deps, { docVersionId: version.docVersionId, sha256: version.sha256, key: version.s3Key, clockId: operation.clockId, expectedDocType: version.docType });
  if (!answer.ok) {
    const failure = await recordReaderFailure(deps, operation, version, atSim);
    return { kind: "UNAVAILABLE", version: failure.version, failures: failure.failures, ...(failure.escalation === undefined ? {} : { escalation: failure.escalation }) };
  }
  const { reading } = answer;
  const effective = effectiveReading(reading, operation);
  const read = { reading, readAtSim: atSim, readerAttempts: version.readerAttempts + 1 };
  const { documents } = deps.connector;
  if (effective.kind === "UNRECOGNIZED") {
    const filed = await documents.updateVersion(operation.operationId, version.docType, version.versionNo, { ...read, state: "UNRECOGNIZED" }, version.version);
    return settleUnrecognized(deps, operation, filed, effective.distrusted, atSim);
  }
  if (effective.docType === version.docType) {
    const filed = await documents.updateVersion(operation.operationId, version.docType, version.versionNo, { ...read, state: "READ" }, version.version);
    return settleRecognized(deps, operation, filed, reading, atSim);
  }
  return refile(deps, operation, version, { ...read, docType: effective.docType }, atSim);
}

interface Refiled {
  readonly reading: NonNullable<DocumentVersion["reading"]>;
  readonly readAtSim: string;
  readonly readerAttempts: number;
  readonly docType: DocumentVersion["docType"];
}

async function refile(deps: ReadingDeps, operation: Operation, version: DocumentVersion, read: Refiled, atSim: string): Promise<ReadResult> {
  const { documents } = deps.connector;
  const { docType, ...reading } = read;
  const duplicate = await currentDuplicate(deps.connector, operation.operationId, docType, version.sha256);
  const classified = await documents.updateVersion(operation.operationId, version.docType, version.versionNo, { ...reading, state: "CLASSIFIED", classifiedAs: docType, classifiedBy: "SYSTEM" }, version.version);
  await settleDocument(deps.connector, operation.operationId, version.docType);
  if (duplicate !== undefined) {
    await recordRead(deps, operation, classified, atSim, { readingStatus: "RECOGNIZED", duplicateOf: duplicate.docVersionId, reclassifiedAs: docType });
    return { kind: "DUPLICATE", version: duplicate };
  }
  const target = await documents.getDocument(operation.operationId, docType);
  const versionNo = target.currentVersion + 1;
  const filed = await fileVersion(deps.connector, {
    operation,
    docType,
    versionNo,
    key: version.s3Key,
    sha256: version.sha256,
    sizeBytes: version.sizeBytes,
    source: version.source,
    receivedAtSim: version.receivedAtSim,
    receivedAtReal: deps.wallClock().toISOString(),
    state: "READ",
    reading: reading.reading,
    readAtSim: reading.readAtSim,
    readerAttempts: reading.readerAttempts,
    expectedDocumentVersion: target.version,
  });
  return settleRecognized(deps, operation, filed, reading.reading, atSim);
}

/** The pending version an id names, if it still is one. */
export async function pendingVersion(connector: Pick<Connector, "documents">, docVersionId: string): Promise<DocumentVersion | undefined> {
  const version = await connector.documents.findVersion(docVersionId);
  return version !== undefined && isPendingVersion(version) ? version : undefined;
}
