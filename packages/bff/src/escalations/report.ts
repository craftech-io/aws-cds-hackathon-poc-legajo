// What the email to the firm's mailbox says about an operation (docs/design-brief.md §5.8,
// copy/firm-mail.ts): the dossier's state, who owes each document, what was tried (every message that
// went out to the importer or the supplier, with its simulated date) and the delay risk with its
// labelled assumptions. Everything comes from the registry; no text of the model reaches the firm.
import type { EscalationReason } from "@legajo/shared";
import { estimateDelayRisk, type DelayRisk } from "../agent-tools/followups/risk";
import type { AttemptLine, DocumentLine, EscalationEmailParams } from "../copy/types";
import type { Message } from "../domain/conversations";
import type { Document } from "../domain/documents";
import type { Operation } from "../domain/operations";
import { type EscalationDeps, argentinaText, consoleUrlOf } from "./ports";

/** A message counts as tried once it left (or was handed to the transport). */
const LEFT: ReadonlySet<Message["status"]> = new Set(["SENT", "DELIVERED", "READ", "DELAYED", "BOUNCED", "COMPLAINED", "QUEUED"]);

/** Every outbound message to a party that left, oldest first. */
export function attemptsOf(messages: readonly Message[]): AttemptLine[] {
  return messages
    .filter((message) => message.direction === "OUT" && message.counterpart !== "FIRM" && LEFT.has(message.status) && message.kind !== undefined)
    .sort((a, b) => Date.parse(a.sentAtSim) - Date.parse(b.sentAtSim))
    .map((message) => ({
      atText: argentinaText(message.sentAtSim),
      channel: message.channel === "EMAIL" ? "EMAIL" : "WHATSAPP",
      recipient: message.counterpart === "SUPPLIER" ? "SUPPLIER" : "IMPORTER",
      kind: message.kind ?? "REPLY",
    }));
}

export function documentLinesOf(documents: readonly Document[]): DocumentLine[] {
  return documents.map((document) => ({ docType: document.docType, status: document.status, ...(document.responsibleParty === undefined ? {} : { responsible: document.responsibleParty }) }));
}

/** The firm's delay risk of the operation at `nowSim` (FirmSettings.assumptions). */
export async function riskOf(deps: Pick<EscalationDeps, "data">, operation: Operation, nowSim: string, documents?: readonly Document[]): Promise<DelayRisk> {
  const [settings, docs] = await Promise.all([deps.data.firms.getSettings(operation.firmId), documents ?? deps.data.documents.listDocuments(operation.operationId)]);
  return estimateDelayRisk({ operation, documents: docs, assumptions: settings.assumptions, nowSim });
}

export interface ReportInput {
  readonly operation: Operation;
  readonly reason: EscalationReason;
  readonly summary: string;
  readonly nowSim: string;
}

/** The parameters of `firmEsAR.escalationEmail`; the risk only while something is missing. */
export async function escalationReport(deps: Pick<EscalationDeps, "data">, input: ReportInput): Promise<EscalationEmailParams> {
  const { operation } = input;
  const [importer, supplier, documents, messages] = await Promise.all([
    deps.data.parties.getImporter(operation.importerId),
    deps.data.parties.getSupplier(operation.supplierId),
    deps.data.documents.listDocuments(operation.operationId),
    deps.data.conversations.listMessages(operation.operationId),
  ]);
  const risk = await riskOf(deps, operation, input.nowSim, documents);
  return {
    operationNumber: operation.operationNumber,
    importerName: importer.name,
    supplierName: supplier.name,
    reason: input.reason,
    summary: input.summary,
    dossierStatus: operation.dossierStatus,
    etaText: argentinaText(operation.eta),
    documents: documentLinesOf(documents),
    attempts: attemptsOf(messages),
    ...(risk.missing.length === 0 ? {} : { riskText: risk.text }),
    consoleUrl: consoleUrlOf(operation.operationId),
  };
}
