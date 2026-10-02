// What a turn's envelope says (docs/design-brief.md §5.2), read from the connector by code: the event
// line, the facts of the dossier, the untrusted text of the turn and the reader's result for the
// documents the turn is about. agent/envelope.ts renders it.
//
//   inbound text   IMPORTER_MESSAGE and SUPPLIER_EMAIL: the body of the inbound `Message` the event
//                  names (normalized and masked when it was stored); BROKER_RELEASED: what the firm
//                  wrote since it took the conversation, so the agent resumes with it. Every other
//                  trigger has none. Subject, file names and PDF metadata never come here.
//   attachments    the versions the intake read (`docVersionIds` of the event) and those the inbound
//                  message carried, only of this operation, with the reader's status and the open
//                  observations each one left.
import type { Channel, GuardrailSource, TurnTrigger } from "@legajo/shared";
import { normalizeInboundText } from "../channels/normalizer";
import type { Connector } from "../connector/index";
import type { Message } from "../domain/conversations";
import { OPEN_OBSERVATION_STATUSES } from "../domain/documents";
import type { Operation } from "../domain/operations";
import { ARGENTINA_TIME_ZONE, toZonedIso } from "../services/business-hours";
import type { AttachmentLine, EnvelopeEvent, FactLine, InboundRole } from "../agent/envelope";
import type { TurnEvent } from "../worker/events";

/** The untrusted text of a turn, and whose it is (the G1 pre-filter only reads a party's text). */
export interface TurnInbound {
  readonly text: string;
  readonly channel: Channel;
  readonly fromRole: InboundRole;
  readonly trusted: boolean;
  readonly truncated: boolean;
  /** `IMPORTER` or `SUPPLIER` for a party's message; `SYSTEM` for the firm's own words. */
  readonly source: GuardrailSource;
  /** The inbound message the turn answers, when there is one. */
  readonly message?: Message;
}

const PARTY_TRIGGERS: Readonly<Partial<Record<TurnTrigger, { readonly role: InboundRole; readonly source: GuardrailSource }>>> = {
  IMPORTER_MESSAGE: { role: "IMPORTER", source: "IMPORTER" },
  SUPPLIER_EMAIL: { role: "SUPPLIER", source: "SUPPLIER" },
};

const zoned = (iso: string): string => toZonedIso(new Date(iso), ARGENTINA_TIME_ZONE);

export function envelopeEvent(event: TurnEvent, operation: Pick<Operation, "operationNumber">): EnvelopeEvent {
  return { type: event.trigger, id: event.eventId, at: zoned(event.eventAtSim), operation: operation.operationNumber };
}

async function partyInbound(data: Pick<Connector, "conversations">, event: TurnEvent, role: InboundRole, source: GuardrailSource): Promise<TurnInbound | undefined> {
  if (event.messageId === undefined) return undefined;
  const message = await data.conversations.getMessage(event.operationId, event.messageId);
  // Only an inbound message of this operation is the turn's text; anything else is a producer's bug.
  if (message === undefined || message.direction !== "IN" || message.operationId !== event.operationId) return undefined;
  if (message.body.trim() === "") return undefined;
  return { text: message.body, channel: message.channel, fromRole: role, trusted: message.trusted, truncated: message.truncated, source, message };
}

/** Since when the firm had the conversation: the last switch of `control` to `BROKER`. */
function takenAt(operation: Operation): string | undefined {
  return [...operation.controlHistory].reverse().find((entry) => entry.control === "BROKER")?.atSim;
}

async function brokerSummary(data: Pick<Connector, "conversations">, operation: Operation): Promise<TurnInbound | undefined> {
  const since = takenAt(operation);
  const written = (await data.conversations.listMessages(operation.operationId, { direction: "OUT" }))
    .filter((message) => message.author.startsWith("BROKER:") && (since === undefined || Date.parse(message.sentAtSim) >= Date.parse(since)))
    .sort((a, b) => Date.parse(a.sentAtSim) - Date.parse(b.sentAtSim));
  if (written.length === 0) return undefined;
  const lines = written.map((message) => `${zoned(message.sentAtSim)} ${message.channel}${message.kind === undefined ? "" : ` ${message.kind}`}: ${message.template === undefined ? message.body : `template ${message.template.name}`}`);
  const normalized = normalizeInboundText(lines.join("\n"));
  return { text: normalized.text, channel: "CONSOLE", fromRole: "BROKER", trusted: true, truncated: normalized.truncated, source: "SYSTEM" };
}

/** The untrusted text of the turn, or `undefined` when the trigger brings none. */
export async function loadInbound(data: Pick<Connector, "conversations">, event: TurnEvent, operation: Operation): Promise<TurnInbound | undefined> {
  const party = PARTY_TRIGGERS[event.trigger];
  if (party !== undefined) return partyInbound(data, event, party.role, party.source);
  if (event.trigger === "BROKER_RELEASED") return brokerSummary(data, operation);
  return undefined;
}

/** State of the dossier, by code; every value is an id, an enum, a count or an instant. */
export async function envelopeFacts(data: Pick<Connector, "documents" | "operations">, operation: Operation, event: TurnEvent): Promise<FactLine[]> {
  const [documents, observations, escalations] = await Promise.all([
    data.documents.listDocuments(operation.operationId),
    data.documents.listObservations(operation.operationId, { statuses: OPEN_OBSERVATION_STATUSES }),
    data.operations.listEscalations(operation.operationId, { status: "OPEN" }),
  ]);
  const previousEta = operation.etaHistory.length > 1 ? operation.etaHistory[operation.etaHistory.length - 2]?.eta : undefined;
  const facts: FactLine[] = [
    { name: "dossier", attributes: { status: operation.dossierStatus, control: operation.control, eta: zoned(operation.eta), ...(previousEta === undefined ? {} : { previousEta: zoned(previousEta) }) } },
    ...documents
      .sort((a, b) => a.docType.localeCompare(b.docType))
      .map((document): FactLine => ({
        name: "document",
        attributes: {
          type: document.docType,
          status: document.status,
          version: document.currentVersion,
          ...(document.responsibleParty === undefined ? {} : { responsible: document.responsibleParty }),
          openObservations: observations.filter((observation) => observation.docType === document.docType).length,
        },
      })),
    { name: "escalations", attributes: { open: escalations.length, reasons: [...new Set(escalations.map((escalation) => escalation.reason))].sort().join(",") } },
    { name: "dispatch", attributes: { status: operation.dispatch.status, ...(operation.dispatch.channel === undefined ? {} : { channel: operation.dispatch.channel }) } },
  ];
  if (event.milestone !== undefined) facts.push({ name: "milestone", attributes: { name: event.milestone } });
  return facts;
}

/** The reader's result for the versions the turn is about (at most 20, of this operation only). */
export async function envelopeAttachments(data: Pick<Connector, "documents">, operation: Operation, event: TurnEvent, inbound: TurnInbound | undefined): Promise<AttachmentLine[]> {
  const fromMessage = (inbound?.message?.attachments ?? []).flatMap((attachment) => (attachment.docVersionId === undefined ? [] : [attachment.docVersionId]));
  const ids = [...new Set([...event.docVersionIds, ...fromMessage])].slice(0, 20);
  if (ids.length === 0) return [];
  const observations = await data.documents.listObservations(operation.operationId, { statuses: OPEN_OBSERVATION_STATUSES });
  const lines: AttachmentLine[] = [];
  for (const id of ids) {
    const version = await data.documents.findVersion(id);
    if (version === undefined || version.operationId !== operation.operationId) continue;
    lines.push({
      docVersionId: version.docVersionId,
      docType: version.docType,
      readingStatus: version.reading?.status ?? "PENDING",
      observations: observations.filter((observation) => observation.lastDocVersionId === version.docVersionId).length,
    });
  }
  return lines;
}
