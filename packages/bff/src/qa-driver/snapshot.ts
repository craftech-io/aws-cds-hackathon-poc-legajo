// `snapshot` (docs/tool-catalog.md): everything a scenario asserts about one operation, read from the
// stored state and the decision log (docs/test-plan.md §4.3: state, structured messages, rules,
// negatives and cost, never the model's wording). Nothing here writes.
import { SIM_MAIL_DOMAIN, parseClockId } from "@legajo/shared";
import type { Connector } from "../connector/index";
import { simNowOf } from "../lib/clock";

/** Mailbox of a world's firm: `estudio-<clockId>@sim…` for a `qa-*` world, the firm's own otherwise. */
export function worldMailbox(clockId: string, firmMailbox: string): string {
  return parseClockId(clockId)?.scope === "QA" ? `estudio-${clockId}@${SIM_MAIL_DOMAIN}` : firmMailbox;
}

export async function buildSnapshot(data: Connector, operationId: string, realNow: Date) {
  const operation = await data.operations.getOperation(operationId);
  const [clock, state, documents, versions, observations, timers, messages, events, notes, escalations, decisions, firm] = await Promise.all([
    data.world.getClock(operation.clockId),
    data.world.getOpState(operationId),
    data.documents.listDocuments(operationId),
    data.documents.listVersions(operationId),
    data.documents.listObservations(operationId),
    data.timers.listTimers(operationId),
    data.conversations.listMessages(operationId),
    data.conversations.listMessageEvents(operationId),
    data.conversations.listTurnNotes(operationId),
    data.operations.listEscalations(operationId),
    data.audit.listByOperation(operationId),
    data.firms.findFirm(operation.firmId),
  ]);
  const [importer, consent, authorizations, supplier, contacts, kpi, mailbox] = await Promise.all([
    data.parties.findImporter(operation.importerId),
    data.parties.getConsent(operation.importerId),
    data.parties.listAuthorizations(operation.importerId),
    data.parties.findSupplier(operation.supplierId),
    data.parties.listContacts(operation.supplierId),
    data.metrics.getKpi({ firmId: operation.firmId, source: "WORLD", clockId: operation.clockId, operationId }),
    firm === undefined ? Promise.resolve([]) : data.conversations.listMailbox(worldMailbox(operation.clockId, firm.mailboxAddress), { limit: 100 }),
  ]);
  return {
    operation: {
      operationId: operation.operationId,
      operationNumber: operation.operationNumber,
      firmId: operation.firmId,
      clockId: operation.clockId,
      worldEpoch: operation.worldEpoch,
      importerId: operation.importerId,
      supplierId: operation.supplierId,
      invoiceNumber: operation.invoiceNumber,
      eta: operation.eta,
      etaHistory: operation.etaHistory,
      dossierStatus: operation.dossierStatus,
      dossierHistory: operation.dossierHistory,
      control: operation.control,
      threadAddress: operation.threadAddress,
      sessionEpoch: operation.sessionEpoch,
      simBehaviour: operation.simBehaviour ?? null,
      dispatch: operation.dispatch,
      approvedBy: operation.approvedBy ?? null,
      version: operation.version,
    },
    clock: { mode: clock.mode, simNow: simNowOf(clock, realNow.getTime()).toISOString(), worldEpoch: clock.worldEpoch },
    processError: state?.processError ?? null,
    inFlight: state?.inFlight ?? [],
    documents,
    versions,
    observations,
    timers,
    pendingTimers: timers.filter((timer) => timer.status === "SCHEDULED").map((timer) => ({ timerKey: `TIMER#${timer.kind}#${timer.timerId}`, kind: timer.kind, dueAtSim: timer.dueAtSim, reason: timer.reason ?? null })),
    messages,
    messageEvents: events,
    turnNotes: notes.map((note) => ({ turnId: note.turnId, trigger: note.trigger, atSim: note.atSim, text: note.text, usage: note.usage ?? null, stopReason: note.stopReason ?? null })),
    escalations,
    decisions,
    parties: {
      importer: importer === undefined ? null : { importerId: importer.importerId, language: importer.language },
      consent: consent === undefined ? null : { grantedAt: consent.grantedAt, revokedAt: consent.revokedAt ?? null },
      authorizations: authorizations.map((row) => ({ supplierId: row.supplierId, authorized: row.authorized })),
      supplier: supplier === undefined ? null : { supplierId: supplier.supplierId, timezone: supplier.timezone, behaviour: supplier.behaviour },
      contacts: contacts.map((contact) => ({ contactId: contact.contactId, email: contact.email, status: contact.status, confirmedBy: contact.confirmedBy ?? null })),
    },
    mailbox: mailbox.filter((message) => message.operationId === operationId),
    usage: kpi === undefined ? null : { turns: kpi.turns, inputTokens: kpi.inputTokens, outputTokens: kpi.outputTokens, cacheReadTokens: kpi.cacheReadTokens, cacheWriteTokens: kpi.cacheWriteTokens },
  };
}

export type QaSnapshot = Awaited<ReturnType<typeof buildSnapshot>>;
