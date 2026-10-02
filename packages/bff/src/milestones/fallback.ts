// FL-097, docs/design-brief.md §5.1: when the turn of the `DOCS_REQUEST` milestone fails (an error or a
// timeout of the Harness, a guardrail, or a turn that ended without the request), the first request
// still reaches the importer: the approved template `legajo_docs_pendientes` with the parameters the
// tools would have returned (firm, operation, vessel, ETA, missing documents), `author SYSTEM`, through
// the same pipeline (policy, hours and window included: it may be deferred), and `ACTION
// AGENT_FALLBACK` once per turn event. Any other milestone has no fallback: its next one follows up.
import type { Connector } from "../connector/connector";
import { missingDocumentsEsAR } from "../copy/es-AR";
import { missingDocuments } from "../agent-tools/followups/risk";
import { etaRowText } from "../channels/whatsapp/routing";
import type { OutboundResult } from "../outbound/types";
import type { MilestoneFallbackInput } from "../worker/ports";
import { type EscalationDeps, derivedMessageId } from "../escalations/ports";
import { skipReason } from "./dossier";

export interface FallbackDeps extends Pick<EscalationDeps, "send" | "wallClock" | "log"> {
  readonly data: Pick<Connector, "operations" | "documents" | "firms" | "conversations" | "audit">;
}

export type FallbackOutcome = { readonly status: "NOT_APPLICABLE" | "ALREADY_SENT" | "SKIPPED"; readonly reason: string } | { readonly status: OutboundResult["status"]; readonly messageId: string };

export async function milestoneFallback(input: MilestoneFallbackInput, deps: FallbackDeps): Promise<FallbackOutcome> {
  const { event } = input;
  if (event.trigger !== "MILESTONE" || event.milestone !== "DOCS_REQUEST") return { status: "NOT_APPLICABLE", reason: "only the DOCS_REQUEST milestone falls back" };
  const operation = await deps.data.operations.getOperation(event.operationId);
  const documents = await deps.data.documents.listDocuments(operation.operationId);
  const skip = skipReason(operation, documents);
  if (skip !== undefined) return { status: "SKIPPED", reason: skip };
  if (input.turnId !== undefined) {
    const sent = await deps.data.conversations.listMessages(operation.operationId, { direction: "OUT" });
    if (sent.some((message) => message.turnId === input.turnId && message.kind === "DOCS_REQUEST" && message.status !== "FAILED")) return { status: "ALREADY_SENT", reason: "the turn already asked for the documents" };
  }
  const firm = await deps.data.firms.getFirm(operation.firmId);
  const missing = missingDocuments(documents);
  const params = [firm.name, operation.operationNumber, operation.vessel, etaRowText(operation.eta), missingDocumentsEsAR(missing)];
  const messageId = derivedMessageId("FALLBACK", event.eventId);
  const correlationId = event.correlationId ?? event.eventId;
  const result = await deps.send(
    {
      channel: "WHATSAPP",
      operationId: operation.operationId,
      kind: "DOCS_REQUEST",
      author: "SYSTEM",
      textSource: "CODE",
      eventAtSim: event.eventAtSim,
      trigger: "MILESTONE",
      template: { name: "legajo_docs_pendientes", params },
      refs: { docTypes: missing },
      messageId,
    },
    { actor: "SYSTEM", correlationId, log: deps.log, refs: { operationId: operation.operationId, eventId: event.eventId, ...(input.turnId === undefined ? {} : { turnId: input.turnId }) } },
  );
  await deps.data.audit.recordOnce(`AGENT_FALLBACK#${operation.operationId}#${event.eventId}`, {
    firmId: operation.firmId,
    decision: "ACTION",
    action: "AGENT_FALLBACK",
    actor: "SYSTEM",
    clockId: operation.clockId,
    operationId: operation.operationId,
    refs: { operationId: operation.operationId, eventId: event.eventId, messageId, ...(input.turnId === undefined ? {} : { turnId: input.turnId }) },
    atSim: event.eventAtSim,
    atReal: deps.wallClock().toISOString(),
    reason: input.cause,
    detail: { milestone: "DOCS_REQUEST", template: "legajo_docs_pendientes", missing, sendStatus: result.status },
    correlationId,
  });
  return { status: result.status, messageId };
}
