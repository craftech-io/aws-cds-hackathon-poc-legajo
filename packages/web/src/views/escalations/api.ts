// Calls of the escalations inbox: `escalations.list` and `escalations.resolve`, both typed by the BFF's
// router. Taking the conversation is the dossier's own action (views/dossier/api.ts).
import { OperationId } from "@legajo/shared";
import type { ConsoleClient } from "../../lib/trpc";
import type { EscalationsList } from "../dossier/types";

export function fetchEscalations(trpc: ConsoleClient, signal: AbortSignal): Promise<EscalationsList> {
  return trpc.escalations.list.query({}, { signal });
}

export interface ResolveInput {
  readonly operationId: string;
  readonly escalationId: string;
  readonly resolution: string;
}

export async function resolveEscalation(trpc: ConsoleClient, input: ResolveInput): Promise<void> {
  await trpc.escalations.resolve.mutate({ operationId: OperationId.parse(input.operationId), escalationId: input.escalationId, resolution: input.resolution });
}
