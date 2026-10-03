// The steps of the main story the local flows share: the request to the importer, the importer handing
// the documents to the supplier, and the clock moved until the supplier's mail is in. Each is the
// stage's own path (milestone, phone tap, worker, outbound pipeline, SimMail, InboundEmail).
import { DOCS_REQUEST_PLAN, EMAIL_DOCS_REQUEST, READ_DOSSIER, READ_OPERATION, reply } from "./plans";
import type { Plan } from "./scripted-harness";
import type { FlowWorld } from "./world";

/** The importer's "Los manda el proveedor": the agent writes to the supplier's ACTIVE contact and tells the importer. */
export const DELEGATE_PLAN: Plan = { steps: [READ_OPERATION, READ_DOSSIER, EMAIL_DOCS_REQUEST, reply("REPLY", "Listo, le escribimos al proveedor.")], note: "Le pedí los documentos al proveedor." };

/** The plans of an operation whose documents the supplier is asked for (merge with the test's own). */
export const DELEGATED = { MILESTONE: [DOCS_REQUEST_PLAN], IMPORTER_MESSAGE: [DELEGATE_PLAN] } as const;

/** "Disparar ahora" of the DOCS_REQUEST and the importer's SUPPLIER_SENDS tap. */
export async function delegateToSupplier(flow: FlowWorld, operationId: string): Promise<void> {
  await flow.fire(operationId, "DOCS_REQUEST");
  await flow.tap(operationId, "SUPPLIER_SENDS");
}

async function inboundEmails(flow: FlowWorld, operationId: string): Promise<number> {
  return (await flow.messages(operationId)).filter((message) => message.direction === "IN" && message.channel === "EMAIL").length;
}

/** Moves the clock event by event until `count` mails of the supplier are in (or `maxMoves` moves). */
export async function untilSupplierWrites(flow: FlowWorld, operationId: string, count = 1, maxMoves = 8): Promise<void> {
  for (let move = 0; move < maxMoves && (await inboundEmails(flow, operationId)) < count; move += 1) await flow.advance({ next: true });
  if ((await inboundEmails(flow, operationId)) < count) throw new Error(`${operationId}: the supplier wrote ${await inboundEmails(flow, operationId)} mail(s) after ${maxMoves} moves`);
}
