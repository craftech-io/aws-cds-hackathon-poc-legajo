// Who the Harness and Memory think a turn belongs to (docs/architecture.md §9.1 and §9.3), in one place
// for the worker, the Memory purge and the QaDriver's `memory.inspect`:
//
//   actorId           `<importerId>-e<worldEpoch>`: the importer's id already starts with `imp-`, so
//                     the actor reads `imp-norpampa-e3` (§9.1 writes it `imp-<importer>-e<epoch>`);
//                     QA importers carry the run id (`imp-qa-<runId>-<scenario>-<key>-e1`), so no two
//                     runs or scenarios share an actor, and a reset (new epoch) starts a new one.
//   runtimeSessionId  keyed hash of operation, clock and both epochs (lib/crypto.ts); a guardrail block
//                     of the Harness raises `sessionEpoch` and the next turn starts a clean session.
//                     A turn opened by the importer's own message (`IMPORTER_MESSAGE`) uses the
//                     importer's conversation session instead (ADR-0017): one Harness session for the
//                     whole WhatsApp chat, whichever operation the turn runs in, so AgentCore Memory
//                     carries the conversation across operations.
//
// Neither carries a phone, an email or a name.
import { ImporterId, type TurnTrigger } from "@legajo/shared";
import type { Operation } from "../domain/operations";
import { type SecretKey, importerSessionId, runtimeSessionId } from "../lib/crypto";

export interface HarnessIdentity {
  readonly actorId: string;
  readonly runtimeSessionId: string;
}

export type IdentityOperation = Pick<Operation, "operationId" | "clockId" | "importerId" | "worldEpoch" | "sessionEpoch">;

/** Memory actor of an importer in one epoch of its world. */
export function actorIdOf(importerId: string, worldEpoch: number): string {
  if (!Number.isInteger(worldEpoch) || worldEpoch < 1) throw new RangeError(`invalid world epoch ${worldEpoch}`);
  return `${ImporterId.parse(importerId)}-e${worldEpoch}`;
}

/** Triggers whose turns run in the importer's conversation session. */
export const CONVERSATION_TRIGGERS: ReadonlySet<TurnTrigger> = new Set<TurnTrigger>(["IMPORTER_MESSAGE"]);

/** Actor and session of a turn; `runtimeSessionKey` is the `runtime-session` subkey. */
export function harnessIdentity(runtimeSessionKey: SecretKey, operation: IdentityOperation, trigger?: TurnTrigger): HarnessIdentity {
  const actorId = actorIdOf(operation.importerId, operation.worldEpoch);
  if (trigger !== undefined && CONVERSATION_TRIGGERS.has(trigger)) {
    return { actorId, runtimeSessionId: importerSessionId(runtimeSessionKey, { importerId: operation.importerId, clockId: operation.clockId, worldEpoch: operation.worldEpoch, sessionEpoch: operation.sessionEpoch }) };
  }
  return {
    actorId,
    runtimeSessionId: runtimeSessionId(runtimeSessionKey, {
      operationId: operation.operationId,
      clockId: operation.clockId,
      worldEpoch: operation.worldEpoch,
      sessionEpoch: operation.sessionEpoch,
    }),
  };
}
