// The status of a document after the intake touched it (CONTEXT.md "Estado del documento"): only the
// reader (a reading without blocking observations) or a broker's waiver make it VALID.
//
//   latest version still being read      MISSING → RECEIVED (any other status stays until it is read)
//   latest read version, blocking open   WITH_OBSERVATION
//   latest read version, nothing open    VALID (`validatedBy` WAIVER when a waived observation remains)
//   nothing read nor pending             a RECEIVED left by a version that turned out to be another
//                                        document goes back to MISSING; anything else is kept
//
// Versions the reader did not recognize, classified or discarded by the firm never move it
// (FL-026: "documento sin cambio de estado").
import type { DocStatus, DocType } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import { type Document, type DocumentVersion, type Observation, type ValidatedBy, type VersionState, isBlocking } from "../domain/documents";

/** States of a version whose reading has not come back yet. */
export const PENDING_STATES: readonly VersionState[] = ["RECEIVED", "READER_UNAVAILABLE"];

export function isPendingVersion(version: Pick<DocumentVersion, "state">): boolean {
  return PENDING_STATES.includes(version.state);
}

interface SettledStatus {
  readonly status: DocStatus;
  readonly validatedBy?: ValidatedBy;
}

/** Pure: the status the versions and observations of one document give it. */
export function settledStatusOf(document: Pick<Document, "status" | "validatedBy">, versions: readonly DocumentVersion[], observations: readonly Observation[]): SettledStatus {
  const keep: SettledStatus = { status: document.status, ...(document.validatedBy === undefined ? {} : { validatedBy: document.validatedBy }) };
  const latest = [...versions].sort((a, b) => b.versionNo - a.versionNo).find((version) => version.state === "READ" || isPendingVersion(version));
  if (latest === undefined) return document.status === "RECEIVED" ? { status: "MISSING" } : keep;
  if (isPendingVersion(latest)) return document.status === "MISSING" ? { status: "RECEIVED" } : keep;
  if (observations.some(isBlocking)) return { status: "WITH_OBSERVATION" };
  return { status: "VALID", validatedBy: observations.some((observation) => observation.status === "WAIVED_BY_BROKER") ? "WAIVER" : "READER" };
}

/** Recomputes and, when it changed, writes the status of one document (pinned to the row's version). */
export async function settleDocument(connector: Pick<Connector, "documents">, operationId: string, docType: DocType): Promise<Document> {
  const [document, versions, observations] = await Promise.all([
    connector.documents.getDocument(operationId, docType),
    connector.documents.listVersions(operationId, docType),
    connector.documents.listObservations(operationId, { docType }),
  ]);
  const next = settledStatusOf(document, versions, observations);
  // `validatedBy` only means something on a VALID document; a stale one on another status is ignored.
  const sameValidation = next.status !== "VALID" || next.validatedBy === document.validatedBy;
  if (next.status === document.status && sameValidation) return document;
  const patch = next.validatedBy === undefined ? { status: next.status } : { status: next.status, validatedBy: next.validatedBy };
  return connector.documents.updateDocument(operationId, docType, patch, document.version);
}
