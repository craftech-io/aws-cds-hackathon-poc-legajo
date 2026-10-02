// What a send is decided with, read once from the registry (docs/design-brief.md §5.7): the operation,
// the recipient resolved from its registered address (`LAM-RECIPIENT`: the importer's phone, the
// supplier contact, the firm's mailbox; never an address the caller wrote), the dated facts the policy
// rebuilds (opt-in, authorization, contact status), the counterpart's recent messages, the holidays
// and the turn's tool results. `policyInputOf` turns it into the engine's input.
import { type ChannelMode, ToolError, type WhatsAppTemplateName } from "@legajo/shared";
import { contactCounterpartKey, importerCounterpartKey } from "../connector/keys";
import type { Message } from "../domain/conversations";
import type { Firm } from "../domain/firms";
import type { Operation } from "../domain/operations";
import type { Consent, Importer, Supplier, SupplierAuthorization, SupplierContact } from "../domain/parties";
import type { TurnResult } from "../domain/runtime";
import type { PolicyInput, PolicyVerdict } from "../policy/types";
import type { HolidayCalendar } from "../services/holidays";
import type { OutboundDeps } from "./deps";
import type { OutboundRequest } from "./types";

/** A local day and the 24-hour window, with margin: what the frequency and window rules look at. */
const HISTORY_LOOKBACK_MS = 48 * 3_600_000;

export type Counterpart = "IMPORTER" | "SUPPLIER" | "FIRM";

export interface SendContext {
  readonly operation: Operation;
  readonly counterpart: Counterpart;
  /** The delivery address from the registry, or `undefined` when the registry has none. */
  readonly to: string | undefined;
  readonly importer?: Importer;
  readonly consent?: Consent;
  readonly authorization?: SupplierAuthorization;
  readonly supplier?: Supplier;
  readonly contact?: SupplierContact;
  /** Read for the emails: the firm's name signs a supplier email, its mailbox receives escalations. */
  readonly firm?: Firm;
  readonly history: readonly Message[];
  readonly holidays?: HolidayCalendar;
  readonly results: readonly TurnResult[];
}

export function counterpartOf(request: OutboundRequest): Counterpart {
  return request.channel === "WHATSAPP" ? "IMPORTER" : request.counterpart;
}

/** The ACTIVE contact that works: the most recently confirmed one that never bounced or complained. */
export function workingContact(contacts: readonly SupplierContact[]): SupplierContact | undefined {
  return contacts
    .filter((contact) => contact.status === "ACTIVE")
    .sort((a, b) => (b.confirmedAt ?? "").localeCompare(a.confirmedAt ?? ""))
    .at(0);
}

async function supplierContact(deps: OutboundDeps, operation: Operation, contactId: string | undefined): Promise<SupplierContact | undefined> {
  if (contactId !== undefined) return deps.data.parties.findContact(operation.supplierId, contactId);
  return workingContact(await deps.data.parties.listContacts(operation.supplierId));
}

async function historyOf(deps: OutboundDeps, key: string | undefined, eventAtSim: string): Promise<Message[]> {
  if (key === undefined) return [];
  const at = Date.parse(eventAtSim);
  return deps.data.conversations.listCounterpartMessages(key, { fromSim: new Date(at - HISTORY_LOOKBACK_MS).toISOString(), toSim: new Date(at + 1).toISOString() });
}

export async function loadSendContext(deps: OutboundDeps, request: OutboundRequest): Promise<SendContext> {
  const operation = await deps.data.operations.findOperation(request.operationId);
  if (operation === undefined) throw new ToolError("NOT_FOUND", "operation not found");
  const counterpart = counterpartOf(request);
  const results = request.turnId === undefined ? [] : await deps.data.runtime.listTurnResults(request.turnId);
  if (counterpart === "IMPORTER") {
    const [importer, consent, holidays] = await Promise.all([deps.data.parties.findImporter(operation.importerId), deps.data.parties.getConsent(operation.importerId), deps.holidays()]);
    const history = await historyOf(deps, importerCounterpartKey(operation.importerId), request.eventAtSim);
    return { operation, counterpart, to: importer?.phoneE164, ...(importer === undefined ? {} : { importer }), ...(consent === undefined ? {} : { consent }), history, holidays, results };
  }
  const firm = await deps.data.firms.findFirm(operation.firmId);
  if (counterpart === "FIRM") return { operation, counterpart, to: firm?.mailboxAddress, ...(firm === undefined ? {} : { firm }), history: [], results };
  const contactId = request.channel === "EMAIL" && request.counterpart === "SUPPLIER" ? request.contactId : undefined;
  const [contact, supplier, authorization] = await Promise.all([
    supplierContact(deps, operation, contactId),
    deps.data.parties.findSupplier(operation.supplierId),
    deps.data.parties.getAuthorization(operation.importerId, operation.supplierId),
  ]);
  const history = await historyOf(deps, contact === undefined ? undefined : contactCounterpartKey(contact.contactId), request.eventAtSim);
  return {
    operation,
    counterpart,
    to: contact?.email,
    ...(firm === undefined ? {} : { firm }),
    ...(contact === undefined ? {} : { contact }),
    ...(supplier === undefined ? {} : { supplier }),
    ...(authorization === undefined ? {} : { authorization }),
    history,
    results,
  };
}

/** `responsibleParty` of the observations a correction request names (`CP-KIND-CHANNEL`). */
export async function responsiblesOf(deps: OutboundDeps, request: OutboundRequest): Promise<PolicyInput["message"]["responsibles"]> {
  if (request.kind !== "CORRECTION_REQUEST") return undefined;
  const ids = request.refs?.observationIds ?? [];
  const observations = await Promise.all(ids.map((id) => deps.data.documents.findObservation(request.operationId, id)));
  return observations.flatMap((observation) => (observation?.responsibleParty === undefined ? [] : [observation.responsibleParty]));
}

export interface Verdicts {
  readonly fence: PolicyVerdict;
  readonly foreignLinks: PolicyVerdict;
  /** `allowed` is set only once the quota was counted (decide.ts). */
  readonly worldQuota: { readonly clockId: string; readonly allowed?: boolean; readonly detail?: string };
}

export interface PolicyMessageParts {
  readonly messageId?: string;
  readonly text?: string;
  readonly template?: { readonly name: WhatsAppTemplateName; readonly params: readonly string[] };
  readonly responsibles?: PolicyInput["message"]["responsibles"];
  readonly whatsappMode: ChannelMode;
  readonly realNow: Date;
}

/** The engine's input for `request` in `context`, with the verdicts of the fence, the links and the quota. */
export function policyInputOf(request: OutboundRequest, context: SendContext, parts: PolicyMessageParts, verdicts: Verdicts): PolicyInput {
  const { operation, importer, consent, authorization, supplier, contact } = context;
  return {
    message: {
      ...(parts.messageId === undefined ? {} : { messageId: parts.messageId }),
      channel: request.channel,
      counterpart: context.counterpart,
      kind: request.kind,
      author: request.author,
      ...(context.to === undefined ? {} : { to: context.to }),
      ...(contact === undefined ? {} : { contactId: contact.contactId }),
      ...(parts.text === undefined ? {} : { text: parts.text }),
      ...(parts.template === undefined ? {} : { template: { name: parts.template.name, params: [...parts.template.params] } }),
      ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
      ...(request.answers === undefined ? {} : { answers: request.answers }),
      ...(parts.responsibles === undefined ? {} : { responsibles: [...parts.responsibles] }),
    },
    operation: {
      operationId: operation.operationId,
      importerId: operation.importerId,
      supplierId: operation.supplierId,
      control: operation.control,
      dossierStatus: operation.dossierStatus,
      controlHistory: operation.controlHistory,
      dossierHistory: operation.dossierHistory,
    },
    importer: {
      importerId: operation.importerId,
      ...(importer === undefined ? {} : { phoneE164: importer.phoneE164 }),
      ...(consent === undefined ? {} : { consent: { ...(consent.revokedAt === undefined ? {} : { revokedAt: consent.revokedAt }), history: consent.history } }),
      ...(authorization === undefined ? {} : { authorization: { authorized: authorization.authorized, history: authorization.history } }),
    },
    ...(supplier === undefined ? {} : { supplier: { supplierId: supplier.supplierId, timezone: supplier.timezone } }),
    ...(contact === undefined ? {} : { contact: { contactId: contact.contactId, supplierId: contact.supplierId, status: contact.status, statusHistory: contact.statusHistory } }),
    history: context.history.map((message) => ({
      messageId: message.messageId,
      direction: message.direction,
      channel: message.channel,
      counterpart: message.counterpart,
      ...(message.kind === undefined ? {} : { kind: message.kind }),
      status: message.status,
      ...(message.importerId === undefined ? {} : { importerId: message.importerId }),
      ...(message.contactId === undefined ? {} : { contactId: message.contactId }),
      sentAtSim: message.sentAtSim,
      sentAtReal: message.sentAtReal,
    })),
    clock: { simNow: request.eventAtSim, realNow: parts.realNow },
    modes: { email: "live", whatsapp: parts.whatsappMode },
    fence: verdicts.fence,
    foreignLinks: verdicts.foreignLinks,
    worldQuota: verdicts.worldQuota,
    ...(context.holidays === undefined ? {} : { holidays: context.holidays }),
  };
}
