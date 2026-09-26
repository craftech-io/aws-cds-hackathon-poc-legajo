// What the console shows of an operation: the row of the list, the dossier and the timeline
// (docs/design-brief.md §6 rows 1-2). Phones and emails of the parties are masked (docs/tool-catalog.md
// "PII"); message bodies are shown as stored, already masked by the normalizer on the way in or
// exactly what the pipeline sent on the way out.
import { maskEmail, maskPhone, operationNumberOf } from "@legajo/shared";
import type { Connector } from "../connector/index";
import type { Message, TurnNote } from "../domain/conversations";
import type { Document, DocumentVersion, Observation } from "../domain/documents";
import type { Escalation, Operation } from "../domain/operations";
import type { Importer, Supplier, SupplierContact } from "../domain/parties";
import type { Timer } from "../domain/timers";

export function operationSummary(operation: Operation) {
  return {
    operationId: operation.operationId,
    operationNumber: operation.operationNumber,
    clockId: operation.clockId,
    importerId: operation.importerId,
    supplierId: operation.supplierId,
    vessel: operation.vessel,
    carrier: operation.carrier,
    portOfLoading: operation.portOfLoading,
    portOfDischarge: operation.portOfDischarge,
    eta: operation.eta,
    dossierStatus: operation.dossierStatus,
    control: operation.control,
    dispatch: { status: operation.dispatch.status, ...(operation.dispatch.channel === undefined ? {} : { channel: operation.dispatch.channel }) },
    openedAtSim: operation.openedAtSim,
  };
}

export function documentView(document: Document) {
  return {
    docType: document.docType,
    status: document.status,
    currentVersion: document.currentVersion,
    ...(document.currentDocVersionId === undefined ? {} : { currentDocVersionId: document.currentDocVersionId }),
    ...(document.responsibleParty === undefined ? {} : { responsibleParty: document.responsibleParty }),
    ...(document.receivedAtSim === undefined ? {} : { receivedAtSim: document.receivedAtSim }),
    ...(document.validatedBy === undefined ? {} : { validatedBy: document.validatedBy }),
  };
}

/** A version without its storage key or hash: the console downloads it through `operations.documentUrl`. */
export function versionView(version: DocumentVersion) {
  return {
    docVersionId: version.docVersionId,
    docType: version.docType,
    versionNo: version.versionNo,
    state: version.state,
    sizeBytes: version.sizeBytes,
    receivedAtSim: version.receivedAtSim,
    source: { party: version.source.party, channel: version.source.channel },
    ...(version.reading === undefined ? {} : { reading: version.reading }),
    ...(version.classifiedAs === undefined ? {} : { classifiedAs: version.classifiedAs }),
  };
}

export function observationView(observation: Observation) {
  return {
    observationId: observation.observationId,
    docType: observation.docType,
    code: observation.code,
    severity: observation.severity,
    status: observation.status,
    attempts: observation.attempts,
    flaggedForReview: observation.flaggedForReview,
    ...(observation.field === undefined ? {} : { field: observation.field }),
    ...(observation.expected === undefined ? {} : { expected: observation.expected }),
    ...(observation.found === undefined ? {} : { found: observation.found }),
    ...(observation.responsibleParty === undefined ? {} : { responsibleParty: observation.responsibleParty }),
    ...(observation.matrixDefault === undefined ? {} : { matrixDefault: observation.matrixDefault }),
    ...(observation.rationale === undefined ? {} : { rationale: observation.rationale }),
    ...(observation.waiveReason === undefined ? {} : { waiveReason: observation.waiveReason }),
  };
}

export function escalationView(escalation: Escalation) {
  return {
    escalationId: escalation.escalationId,
    operationId: escalation.operationId,
    operationNumber: operationNumberOf(escalation.operationId),
    reason: escalation.reason,
    summary: escalation.summary,
    status: escalation.status,
    openedAtSim: escalation.openedAtSim,
    openedBy: escalation.openedBy,
    ...(escalation.observationId === undefined ? {} : { observationId: escalation.observationId }),
    ...(escalation.resolvedAtSim === undefined ? {} : { resolvedAtSim: escalation.resolvedAtSim, resolvedBy: escalation.resolvedBy, resolution: escalation.resolution }),
  };
}

export function importerView(importer: Importer) {
  return {
    importerId: importer.importerId,
    name: importer.name,
    contactName: importer.contactName,
    phoneMasked: maskPhone(importer.phoneE164),
    language: importer.language,
  };
}

export function contactView(contact: SupplierContact) {
  return {
    contactId: contact.contactId,
    emailMasked: maskEmail(contact.email),
    status: contact.status,
    ...(contact.confirmedBy === undefined ? {} : { confirmedBy: contact.confirmedBy }),
    ...(contact.confirmedAt === undefined ? {} : { confirmedAt: contact.confirmedAt }),
  };
}

export function supplierView(supplier: Supplier, contacts: readonly SupplierContact[]) {
  return {
    supplierId: supplier.supplierId,
    name: supplier.name,
    country: supplier.country,
    timezone: supplier.timezone,
    language: supplier.language,
    behaviour: supplier.behaviour,
    contacts: contacts.map(contactView),
  };
}

/** An address as the timeline shows it: phones and emails masked, anything else (`simulated`) as is. */
export function maskedAddress(address: string): string {
  if (address.includes("@")) return maskEmail(address);
  return /^\+\d{8,15}$/.test(address) ? maskPhone(address) : address;
}

export type TimelineEntry =
  | { readonly type: "MESSAGE"; readonly atSim: string; readonly message: ReturnType<typeof messageView> }
  | { readonly type: "NOTE"; readonly atSim: string; readonly turnId: string; readonly trigger: string; readonly text: string }
  | { readonly type: "ESCALATION"; readonly atSim: string; readonly escalation: ReturnType<typeof escalationView> };

export function messageView(message: Message) {
  return {
    messageId: message.messageId,
    direction: message.direction,
    channel: message.channel,
    counterpart: message.counterpart,
    author: message.author,
    status: message.status,
    body: message.body,
    to: maskedAddress(message.to),
    from: maskedAddress(message.from),
    sentAtSim: message.sentAtSim,
    buttons: message.buttons.map((button) => ({ action: button.action, title: button.title })),
    attachments: message.attachments.map((attachment) => ({ index: attachment.index, status: attachment.status, sizeBytes: attachment.sizeBytes, ...(attachment.docVersionId === undefined ? {} : { docVersionId: attachment.docVersionId }) })),
    ...(message.kind === undefined ? {} : { kind: message.kind }),
    ...(message.subject === undefined ? {} : { subject: message.subject }),
    ...(message.template === undefined ? {} : { template: message.template.name }),
    ...(message.policy === undefined ? {} : { policy: message.policy }),
  };
}

/** Messages, turn notes and escalations of an operation in simulated order; pending timers apart, with their reason. */
export function timelineOf(messages: readonly Message[], notes: readonly TurnNote[], escalations: readonly Escalation[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...messages.map((message): TimelineEntry => ({ type: "MESSAGE", atSim: message.sentAtSim, message: messageView(message) })),
    ...notes.map((note): TimelineEntry => ({ type: "NOTE", atSim: note.atSim, turnId: note.turnId, trigger: note.trigger, text: note.text })),
    ...escalations.map((escalation): TimelineEntry => ({ type: "ESCALATION", atSim: escalation.openedAtSim, escalation: escalationView(escalation) })),
  ];
  return entries.sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim));
}

export function pendingTimerView(timer: Timer) {
  return { kind: timer.kind, timerId: timer.timerId, dueAtSim: timer.dueAtSim, ...(timer.reason === undefined ? {} : { reason: timer.reason }) };
}

/** Parties of a list, read once each. */
export async function partyNames(data: Connector, operations: readonly Operation[]): Promise<{ importers: Map<string, string>; suppliers: Map<string, string> }> {
  const importerIds = [...new Set(operations.map((operation) => operation.importerId))];
  const supplierIds = [...new Set(operations.map((operation) => operation.supplierId))];
  const [importers, suppliers] = await Promise.all([
    Promise.all(importerIds.map((id) => data.parties.findImporter(id))),
    Promise.all(supplierIds.map((id) => data.parties.findSupplier(id))),
  ]);
  return {
    importers: new Map(importers.flatMap((importer) => (importer ? [[importer.importerId, importer.name] as const] : []))),
    suppliers: new Map(suppliers.flatMap((supplier) => (supplier ? [[supplier.supplierId, supplier.name] as const] : []))),
  };
}
