// Calls of the operations view. `operations.list` is typed by the BFF's router; `operations.create`
// (create_operation, docs/tool-catalog.md) is called by name and its answer validated with zod, like
// every edge of the console, so the view keeps working whichever fields the router adds.
import { OperationId, OperationNumber } from "@legajo/shared";
import { getUntypedClient } from "@trpc/client";
import { z } from "zod";
import type { ConsoleClient } from "../../lib/trpc";
import type { OperationsList } from "../dossier/types";

export function fetchOperations(trpc: ConsoleClient, signal: AbortSignal): Promise<OperationsList> {
  return trpc.operations.list.query({}, { signal });
}

const Created = z.looseObject({ operationId: OperationId });

/** Brings an operation from the customs platform by number; answers the id of the new operation. */
export async function createOperation(trpc: ConsoleClient, operationNumber: string): Promise<string> {
  const raw = await getUntypedClient(trpc).mutation("operations.create", { operationNumber: OperationNumber.parse(operationNumber) });
  return Created.parse(raw).operationId;
}
