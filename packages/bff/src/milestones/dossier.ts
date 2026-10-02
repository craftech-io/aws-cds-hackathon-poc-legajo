// Whether anything is left to chase in an operation (FL-008): a complete dossier (every document
// `VALID`; a waived observation already made its document VALID), one waiting for review or approved,
// and a released dispatch need no milestone, follow-up or fallback.
import type { Document } from "../domain/documents";
import type { Operation } from "../domain/operations";

/** Reasons a milestone or a follow-up is skipped (`Timer.reason`, `AuditLog.reason`). */
export const MILESTONE_SKIP = {
  COMPLETE: "DOSSIER_COMPLETE",
  APPROVED: "DOSSIER_APPROVED",
  RELEASED: "DISPATCH_RELEASED",
} as const;

/** Every document `VALID`. */
export function isDossierComplete(documents: readonly Pick<Document, "status">[]): boolean {
  return documents.length > 0 && documents.every((document) => document.status === "VALID");
}

/** Why nothing is left to do for this operation, or `undefined`. */
export function skipReason(operation: Pick<Operation, "dossierStatus" | "dispatch">, documents: readonly Pick<Document, "status">[]): string | undefined {
  if (operation.dispatch.status === "LIBERADO") return MILESTONE_SKIP.RELEASED;
  if (operation.dossierStatus === "APPROVED") return MILESTONE_SKIP.APPROVED;
  if (operation.dossierStatus === "READY_FOR_REVIEW" || isDossierComplete(documents)) return MILESTONE_SKIP.COMPLETE;
  return undefined;
}
