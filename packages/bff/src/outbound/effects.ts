// What a send that went out leaves in the dossier (docs/flows-catalog.md FL-007, FL-012, FL-022,
// FL-024, FL-028), applied once the transport took it (deliver.ts), never for a refused or deferred
// one (a deferred send applies them when its timer delivers it):
//
//   requested   a `DOCS_REQUEST` or `REMINDER` naming documents: each one's `requestedFrom` is the
//               party it went to (IMPORTER by WhatsApp, SUPPLIER by email) and `lastRequestedAtSim`
//   attempts    a `CORRECTION_REQUEST` naming observations: each OPEN one counts its attempt and
//               becomes CORRECTION_REQUESTED (intake/attempts.ts, the two-attempt rule's input)
//   reminder    a `REMINDER` to a supplier contact: the contact's `lastReminderAt`
import type { DocType, Party } from "@legajo/shared";
import type { Actor } from "../domain/common";
import { recordCorrectionRequest } from "../intake/attempts";
import type { SendContext } from "./context";
import type { OutboundDeps } from "./deps";
import type { OutboundRequest } from "./types";

const REQUEST_KINDS = new Set<OutboundRequest["kind"]>(["DOCS_REQUEST", "REMINDER"]);

async function markRequested(deps: Pick<OutboundDeps, "data">, operationId: string, docTypes: readonly DocType[], party: Party, atSim: string): Promise<void> {
  for (const docType of new Set(docTypes)) {
    const document = await deps.data.documents.getDocument(operationId, docType);
    if (document.status === "VALID") continue;
    await deps.data.documents.updateDocument(operationId, docType, { requestedFrom: party, lastRequestedAtSim: atSim }, document.version);
  }
}

export async function applySentEffects(deps: Pick<OutboundDeps, "data" | "wallClock">, input: { readonly request: OutboundRequest; readonly context: SendContext; readonly sentAtSim: string; readonly actor: Actor }): Promise<void> {
  const { request, context, sentAtSim } = input;
  const { operationId } = context.operation;
  const refs = request.refs ?? {};
  if (REQUEST_KINDS.has(request.kind) && refs.docTypes !== undefined && refs.docTypes.length > 0) {
    await markRequested(deps, operationId, refs.docTypes, request.channel === "WHATSAPP" ? "IMPORTER" : "SUPPLIER", sentAtSim);
  }
  if (request.kind === "CORRECTION_REQUEST" && refs.observationIds !== undefined && refs.observationIds.length > 0) {
    await recordCorrectionRequest(deps.data, { operationId, observationIds: refs.observationIds, atSim: sentAtSim, atReal: deps.wallClock().toISOString(), by: input.actor });
  }
  if (request.kind === "REMINDER" && request.channel === "EMAIL" && context.contact !== undefined) {
    await deps.data.parties.markContactReminder(context.contact.supplierId, context.contact.contactId, sentAtSim);
  }
}
