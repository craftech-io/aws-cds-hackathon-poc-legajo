// Filing a version of a document (docs/architecture.md §5 `DOC#<docType>#V#<nnn>`) and counting the
// reader's failures on it. A version and the document that points to it are one transaction pinned
// to the document's row version (connector `addVersion`), so two intakes of one operation, which the
// FIFO already serializes, can never write the same version number.
import type { DocType } from "@legajo/shared";
import type { Reading } from "@legajo/reader-contract";
import type { Connector } from "../connector/connector";
import type { DocumentPatch } from "../connector/ports";
import type { DocumentVersion, VersionSource, VersionState } from "../domain/documents";
import type { Operation } from "../domain/operations";
import { operationRef, readerUnavailableEscalation, READER_FAILURES_TO_ESCALATE } from "./escalation-rules";
import type { EscalationOutcome, ReadingDeps } from "./ports";

export interface NewVersion {
  readonly operation: Operation;
  readonly docType: DocType;
  readonly versionNo: number;
  readonly key: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly source: VersionSource;
  readonly receivedAtSim: string;
  readonly receivedAtReal: string;
  readonly state: VersionState;
  readonly reading?: Reading;
  readonly readAtSim?: string;
  readonly readerAttempts: number;
  /** Version of the document row the caller read to compute `versionNo`. */
  readonly expectedDocumentVersion: number;
  readonly document?: DocumentPatch;
}

export async function fileVersion(connector: Pick<Connector, "documents">, input: NewVersion): Promise<DocumentVersion> {
  const { operation } = input;
  const { version } = await connector.documents.addVersion({
    version: {
      operationId: operation.operationId,
      clockId: operation.clockId,
      docType: input.docType,
      versionNo: input.versionNo,
      s3Key: input.key,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      source: input.source,
      receivedAtSim: input.receivedAtSim,
      receivedAtReal: input.receivedAtReal,
      state: input.state,
      readerAttempts: input.readerAttempts,
      ...(input.reading === undefined ? {} : { reading: input.reading }),
      ...(input.readAtSim === undefined ? {} : { readAtSim: input.readAtSim }),
      ...(operation.runId === undefined ? {} : { runId: operation.runId }),
    },
    expectedDocumentVersion: input.expectedDocumentVersion,
    ...(input.document === undefined ? {} : { document: input.document }),
  });
  return version;
}

/**
 * The latest version the reader read of the document when it is exactly this file (FL-025: "duplicada").
 * Versions it did not recognize, or that turned out to be another document, are not the document's.
 */
export async function currentDuplicate(connector: Pick<Connector, "documents">, operationId: string, docType: DocType, sha256: string): Promise<DocumentVersion | undefined> {
  const versions = await connector.documents.listVersions(operationId, docType);
  const latestRead = versions.filter((version) => version.state === "READ").sort((a, b) => b.versionNo - a.versionNo)[0];
  return latestRead !== undefined && latestRead.sha256 === sha256 ? latestRead : undefined;
}

export interface ReaderFailure {
  readonly version: DocumentVersion;
  /** Failed readings of the version so far, this one included. */
  readonly failures: number;
  readonly escalation?: EscalationOutcome;
}

/**
 * One more failed reading of a filed version: it stays RECEIVED (no invented reading, FL-096) and,
 * from the third failure on, READER_UNAVAILABLE, the third one escalating to the firm once.
 */
export async function recordReaderFailure(deps: Pick<ReadingDeps, "connector" | "escalate">, operation: Operation, version: DocumentVersion, atSim: string): Promise<ReaderFailure> {
  const failures = version.readerAttempts + 1;
  const state: VersionState = failures >= READER_FAILURES_TO_ESCALATE ? "READER_UNAVAILABLE" : "RECEIVED";
  const updated = await deps.connector.documents.updateVersion(operation.operationId, version.docType, version.versionNo, { readerAttempts: failures, state }, version.version);
  const request = readerUnavailableEscalation(operationRef(operation), updated, failures, atSim);
  if (request === undefined) return { version: updated, failures };
  return { version: updated, failures, escalation: await deps.escalate(request) };
}
