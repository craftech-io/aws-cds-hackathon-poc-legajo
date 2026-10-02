// What a firm decision on a document leaves behind (FL-043, FL-044, FL-072): when the three documents
// are `VALID` and the agent still works on the dossier (`OPEN` or `REOPENED`), the worker's
// `request_approval` moves it to `READY_FOR_REVIEW` and mails the firm, exactly as when the last reading
// completes it. Approving stays a person's act (ADR-0010): nothing here approves.
import type { DocStatus } from "@legajo/shared";
import type { Operation } from "../../domain/operations";
import { newConsoleEventId } from "../conversation-control/outbound-send";
import type { DirectContext } from "../operations-admin/handler-kit";
import type { ServiceDeps } from "../operations-admin/ports";

const AWAITING_COMPLETION: ReadonlySet<Operation["dossierStatus"]> = new Set(["OPEN", "REOPENED"]);

export function isComplete(statuses: readonly DocStatus[]): boolean {
  return statuses.length === 3 && statuses.every((status) => status === "VALID");
}

/** `true` when the decision completed the dossier and the approval was requested. */
export async function requestApprovalIfComplete(ctx: DirectContext<unknown>, deps: ServiceDeps, operation: Operation, atSim: string): Promise<boolean> {
  if (!AWAITING_COMPLETION.has(operation.dossierStatus)) return false;
  const documents = await ctx.connector.documents.listDocuments(operation.operationId);
  if (!isComplete(documents.map((document) => document.status))) return false;
  await deps.approvals.requestApproval({ operationId: operation.operationId, firmId: operation.firmId, clockId: operation.clockId, atSim, eventId: newConsoleEventId(ctx.now().getTime()) });
  return true;
}
