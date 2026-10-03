// Calls of the operations view, typed by the BFF's `AppRouter`: `operations.list`, and
// `operations.create` (create_operation, docs/tool-catalog.md; FL-005), whose number is checked in the
// browser with the shared schema before it leaves. The direct handler answers a record, so the id of
// the new operation is read with the shared schema too.
import { OperationId, OperationNumber } from "@legajo/shared";
import type { ConsoleClient } from "../../lib/trpc";
import type { OperationsList } from "../dossier/types";

export function fetchOperations(trpc: ConsoleClient, signal: AbortSignal): Promise<OperationsList> {
  return trpc.operations.list.query({}, { signal });
}

/** Brings an operation from the customs platform by number; answers the id of the new operation. */
export async function createOperation(trpc: ConsoleClient, operationNumber: string): Promise<string> {
  const created = await trpc.operations.create.mutate({ operationNumber: OperationNumber.parse(operationNumber) });
  return OperationId.parse(created.operationId);
}
