// Connector ports by use case (docs/build-plan.md WP-07): firms, parties with conditional `ADDR#`
// claims, operations, documents and their versions and observations, and timers. Tools, handlers,
// routers and the worker import these types and get the implementation from connector/index.ts;
// none of them touches @aws-sdk/lib-dynamodb. Every transition is pinned to a `version` (the
// caller's `expectedVersion`, or the one the adapter just read) and appends its dated history in the
// same write. The rest of the ports (conversations, audit, runtime, world state, metrics) are in
// ports-runtime.ts.
import type {
  ConversationControl,
  CustomsChannel,
  DispatchStatus,
  DocStatus,
  DocType,
  DossierStatus,
  ObservationStatus,
  SupplierContactStatus,
  TimerFiredBy,
  TimerKind,
  TimerStatus,
} from "@legajo/shared";
import type { HistoryStamp, NewEntity } from "../domain/common";
import type { Document, DocumentVersion, Observation } from "../domain/documents";
import type { Broker, Checklist, Firm, FirmSettings, ResponsibilityMatrix } from "../domain/firms";
import type { Escalation, EtaSource, Operation } from "../domain/operations";
import type { AddressClaim, Consent, ContactConfirmer, Importer, Supplier, SupplierAuthorization, SupplierContact, SupplierProfile } from "../domain/parties";
import type { Timer } from "../domain/timers";

/** An identity lookup never picks one of several rows: two matches is an audited error, not an identity. */
export type IdentityLookup<T> =
  | { readonly status: "NONE" }
  | { readonly status: "UNIQUE"; readonly value: T }
  | { readonly status: "AMBIGUOUS"; readonly ids: readonly string[] };

export interface FirmsPort {
  getFirm(firmId: string): Promise<Firm>;
  /** Every firm of the given kinds (a small table: the daily `PolicyAudit` lists DEMO and GUEST firms). */
  listFirms(kinds: readonly Firm["kind"][]): Promise<Firm[]>;
  findFirm(firmId: string): Promise<Firm | undefined>;
  getSettings(firmId: string): Promise<FirmSettings>;
  getBroker(firmId: string, brokerId: string): Promise<Broker>;
  listBrokers(firmId: string): Promise<Broker[]>;
  /** The broker row a Cognito `sub` belongs to, only inside that firm (the console principal). */
  findBrokerBySub(firmId: string, sub: string): Promise<Broker | undefined>;
  /** `console:invite`: binds the Cognito user to the broker row (GSI1 `SUB#<sub>`). */
  setBrokerCognitoSub(firmId: string, brokerId: string, sub: string): Promise<Broker>;
  /** Latest version of the checklist of a document type. */
  getChecklist(firmId: string, docType: DocType): Promise<Checklist | undefined>;
  /** Latest version of each document type's checklist. */
  listChecklists(firmId: string): Promise<Checklist[]>;
  getResponsibilityMatrix(firmId: string): Promise<ResponsibilityMatrix | undefined>;
}

export interface ConsentGrant extends HistoryStamp {
  readonly importerId: string;
  readonly medium: Consent["medium"];
  readonly textVersion: string;
}

export interface ConsentRevocation extends HistoryStamp {
  readonly importerId: string;
}

export interface AuthorizationChange extends HistoryStamp {
  readonly importerId: string;
  readonly supplierId: string;
  readonly authorized: boolean;
  /** Broker who registered the change (`authorize_supplier_contact`). */
  readonly brokerId?: string;
}

export type NewContact = Omit<NewEntity<typeof SupplierContact>, "statusHistory"> & { readonly created: HistoryStamp };

export interface ContactTransition extends HistoryStamp {
  readonly supplierId: string;
  readonly contactId: string;
  readonly to: SupplierContactStatus;
  /** Required when the transition is a confirmation (`to: ACTIVE`). */
  readonly confirmedBy?: ContactConfirmer;
  readonly expectedVersion?: number;
}

export type ImporterPatch = Partial<Pick<Importer, "name" | "contactName" | "contactFirstName" | "phoneE164" | "phoneHash" | "language">>;
export type SupplierPatch = Partial<Pick<Supplier, "name" | "country" | "timezone" | "language" | "behaviour" | "behaviourParams">>;

export interface PartiesPort {
  getImporter(importerId: string): Promise<Importer>;
  findImporter(importerId: string): Promise<Importer | undefined>;
  /** Identity of an inbound WhatsApp: GSI1 `phoneHash`; `ADDR#` keeps it unique at write time. */
  findImporterByPhoneHash(phoneHash: string): Promise<IdentityLookup<Importer>>;
  listImporters(firmId: string, options?: { readonly clockId?: string }): Promise<Importer[]>;
  /** The importer and its phone claim in one transaction; a phone in use is a CONFLICT and writes nothing. */
  createImporter(importer: NewEntity<typeof Importer>): Promise<Importer>;
  /** A phone change moves the claim in the same transaction (new one conditional, old one released). */
  updateImporter(importerId: string, patch: ImporterPatch, expectedVersion?: number): Promise<Importer>;
  getConsent(importerId: string): Promise<Consent | undefined>;
  grantConsent(grant: ConsentGrant): Promise<Consent>;
  revokeConsent(revocation: ConsentRevocation): Promise<Consent>;
  getAuthorization(importerId: string, supplierId: string): Promise<SupplierAuthorization | undefined>;
  listAuthorizations(importerId: string): Promise<SupplierAuthorization[]>;
  setAuthorization(change: AuthorizationChange): Promise<SupplierAuthorization>;
  getSupplier(supplierId: string): Promise<Supplier>;
  findSupplier(supplierId: string): Promise<Supplier | undefined>;
  listSuppliers(firmId: string, options?: { readonly clockId?: string }): Promise<Supplier[]>;
  createSupplier(supplier: NewEntity<typeof Supplier>): Promise<Supplier>;
  updateSupplier(supplierId: string, patch: SupplierPatch, expectedVersion?: number): Promise<Supplier>;
  getContact(supplierId: string, contactId: string): Promise<SupplierContact>;
  findContact(supplierId: string, contactId: string): Promise<SupplierContact | undefined>;
  listContacts(supplierId: string): Promise<SupplierContact[]>;
  /** Uniqueness checks only; the sender of an email is always decided among the contacts of its operation's supplier. */
  findContactsByEmailHash(emailHash: string): Promise<SupplierContact[]>;
  /** The contact and its email claim in one transaction; an email in use is a CONFLICT. */
  createContact(contact: NewContact): Promise<SupplierContact>;
  transitionContact(transition: ContactTransition): Promise<SupplierContact>;
  /**
   * The importer said "No" to a proposed contact: a PENDING_CONFIRMATION contact and its email claim
   * go away together (a contact that was ever ACTIVE keeps its history for `PolicyAudit`).
   */
  discardContact(supplierId: string, contactId: string, expectedVersion?: number): Promise<void>;
  getProfile(supplierId: string): Promise<SupplierProfile | undefined>;
  putProfile(profile: NewEntity<typeof SupplierProfile>): Promise<SupplierProfile>;
  getAddressClaim(addressHash: string): Promise<AddressClaim | undefined>;
  /** Claims an address on its own (thread addresses, firm mailboxes); CONFLICT when taken. */
  claimAddress(claim: NewEntity<typeof AddressClaim>): Promise<AddressClaim>;
  /** Releases a claim only if `ownerId` still holds it. */
  releaseAddress(addressHash: string, ownerId: string): Promise<void>;
}

export interface CreateOperationInput extends Omit<NewEntity<typeof Operation>, "etaHistory" | "dossierHistory" | "controlHistory"> {
  /** When and by whom it was created; also the first entry of every history. */
  readonly created: HistoryStamp;
  readonly etaSource: EtaSource;
  /** Initial status per document (all `MISSING` unless the platform brings something else). */
  readonly documents?: Partial<Record<DocType, DocStatus>>;
  /** `emailHash(threadAddress)`: the thread address claim, written in the same transaction. */
  readonly threadClaimHash?: string;
}

export interface DossierTransition extends HistoryStamp {
  readonly operationId: string;
  readonly to: DossierStatus;
  /** Broker who approved (only with `to: APPROVED`). */
  readonly approvedBy?: string;
  readonly expectedVersion?: number;
}

export interface ControlChange extends HistoryStamp {
  readonly operationId: string;
  readonly control: ConversationControl;
  readonly expectedVersion?: number;
}

export interface EtaChange {
  readonly operationId: string;
  readonly eta: string;
  readonly atSim: string;
  readonly atReal?: string;
  readonly source: EtaSource;
  readonly eventId?: string;
  readonly expectedVersion?: number;
}

export interface DispatchChange {
  readonly operationId: string;
  readonly status: DispatchStatus;
  readonly channel?: CustomsChannel;
  readonly occurredAtSim: string;
  readonly eventId?: string;
  readonly expectedVersion?: number;
}

export type OperationPatch = Partial<Pick<Operation, "simBehaviour" | "simBehaviourParams" | "simState" | "vessel" | "carrier" | "atRisk">>;

export type NewEscalation = Omit<NewEntity<typeof Escalation>, "escalationId" | "status">;

export interface EscalationResolution {
  readonly operationId: string;
  readonly escalationId: string;
  readonly atSim: string;
  readonly by: HistoryStamp["by"];
  readonly resolution?: string;
  readonly expectedVersion?: number;
}

export interface OperationsPort {
  getOperation(operationId: string): Promise<Operation>;
  findOperation(operationId: string): Promise<Operation | undefined>;
  /** GSI2 `THREAD#<number>-<tag>`: the operation an email to `op-<number>-<tag>@` belongs to. */
  findOperationByThread(operationNumber: string, threadTag: string): Promise<IdentityLookup<Operation>>;
  /** GSI1 by firm and status, sorted by ETA; optional filters by importer and world. */
  listOperations(firmId: string, options?: { readonly statuses?: readonly DossierStatus[]; readonly importerId?: string; readonly clockId?: string }): Promise<Operation[]>;
  /** The operation, its three documents and (optionally) its thread claim, all or nothing. */
  createOperation(input: CreateOperationInput): Promise<Operation>;
  updateOperation(operationId: string, patch: OperationPatch, expectedVersion?: number): Promise<Operation>;
  /** Refuses a transition `DOSSIER_TRANSITIONS` does not allow (VALIDATION) and a stale version (CONFLICT). */
  transitionDossier(transition: DossierTransition): Promise<Operation>;
  setControl(change: ControlChange): Promise<Operation>;
  changeEta(change: EtaChange): Promise<Operation>;
  recordDispatch(change: DispatchChange): Promise<Operation>;
  /** `sessionEpoch + 1` after a G1 block of the Harness; returns the new epoch. */
  nextSessionEpoch(operationId: string): Promise<number>;
  /** One OPEN escalation per reason and operation: a second call returns the open one (`created: false`). */
  openEscalation(escalation: NewEscalation): Promise<{ readonly escalation: Escalation; readonly created: boolean }>;
  getEscalation(operationId: string, escalationId: string): Promise<Escalation>;
  listEscalations(operationId: string, options?: { readonly status?: Escalation["status"] }): Promise<Escalation[]>;
  listOpenEscalationsByFirm(firmId: string): Promise<Escalation[]>;
  markEscalationEmailed(operationId: string, escalationId: string): Promise<Escalation>;
  resolveEscalation(resolution: EscalationResolution): Promise<Escalation>;
}

export type DocumentPatch = Partial<Pick<Document, "status" | "responsibleParty" | "requestedFrom" | "lastRequestedAtSim" | "validatedBy">>;
export type VersionPatch = Partial<Pick<DocumentVersion, "state" | "reading" | "readAtSim" | "readerAttempts" | "classifiedAs" | "classifiedBy" | "discardedBy">>;
export type ObservationPatch = Partial<
  Pick<Observation, "responsibleParty" | "matrixDefault" | "matchesMatrix" | "flaggedForReview" | "rationale" | "severity" | "expected" | "found" | "field" | "escalationId" | "waiveReason">
>;

export interface NewVersionInput {
  readonly version: Omit<NewEntity<typeof DocumentVersion>, "docVersionId">;
  /** Document fields to change with the new version (status, responsible…). */
  readonly document?: DocumentPatch;
  /** Version of the `DOC#` row the caller read to compute `versionNo`. */
  readonly expectedDocumentVersion?: number;
}

export type NewObservation = Omit<NewEntity<typeof Observation>, "history" | "attempts" | "flaggedForReview"> & { readonly created: HistoryStamp };

export interface ObservationTransition extends HistoryStamp {
  readonly operationId: string;
  readonly observationId: string;
  readonly to: ObservationStatus;
  /** The version that produced the transition; becomes `lastDocVersionId`. */
  readonly docVersionId?: string;
  /** Adds one to `attempts` in the same write (a correction was requested, or came back wrong). */
  readonly countAttempt?: boolean;
  readonly patch?: ObservationPatch;
  readonly expectedVersion?: number;
}

export interface DocumentsPort {
  listDocuments(operationId: string): Promise<Document[]>;
  getDocument(operationId: string, docType: DocType): Promise<Document>;
  updateDocument(operationId: string, docType: DocType, patch: DocumentPatch, expectedVersion?: number): Promise<Document>;
  /** Writes version `currentVersion + 1` and moves the document to it, all or nothing. */
  addVersion(input: NewVersionInput): Promise<{ readonly version: DocumentVersion; readonly document: Document }>;
  getVersion(operationId: string, docType: DocType, versionNo: number): Promise<DocumentVersion>;
  /** By `dv-<operation>-<CI|PL|CO>-<n>`; `undefined` for an id of another operation or none at all. */
  findVersion(docVersionId: string): Promise<DocumentVersion | undefined>;
  listVersions(operationId: string, docType?: DocType): Promise<DocumentVersion[]>;
  updateVersion(operationId: string, docType: DocType, versionNo: number, patch: VersionPatch, expectedVersion?: number): Promise<DocumentVersion>;
  listObservations(operationId: string, options?: { readonly docType?: DocType; readonly statuses?: readonly ObservationStatus[] }): Promise<Observation[]>;
  getObservation(operationId: string, observationId: string): Promise<Observation>;
  findObservation(operationId: string, observationId: string): Promise<Observation | undefined>;
  /** CONFLICT when the observation of that document and code already exists (count an attempt instead). */
  createObservation(observation: NewObservation): Promise<Observation>;
  updateObservation(operationId: string, observationId: string, patch: ObservationPatch, expectedVersion?: number): Promise<Observation>;
  transitionObservation(transition: ObservationTransition): Promise<Observation>;
}

export interface TimerCompletion {
  readonly operationId: string;
  readonly timerKey: string;
  readonly status: Exclude<TimerStatus, "SCHEDULED">;
  readonly atSim: string;
  readonly firedBy?: TimerFiredBy;
  readonly reason?: string;
  readonly expectedVersion?: number;
}

export interface TimersPort {
  /** SCHEDULED timers enter GSI3 (`CLOCK#<clockId>` + `dueAtSim`); CONFLICT when the key exists. */
  createTimer(timer: NewEntity<typeof Timer>): Promise<Timer>;
  getTimer(operationId: string, timerKey: string): Promise<Timer>;
  findTimer(operationId: string, timerKey: string): Promise<Timer | undefined>;
  listTimers(operationId: string, options?: { readonly kind?: TimerKind; readonly status?: TimerStatus }): Promise<Timer[]>;
  /** SCHEDULED timers of a world due at or before `until`, oldest first (what "Avanzar" dispatches). */
  listDueTimers(clockId: string, until: string, options?: { readonly limit?: number }): Promise<Timer[]>;
  /** SCHEDULED timers of a world due in `[from, until)`, oldest first (the RUNNING horizon). */
  listScheduledTimers(clockId: string, options?: { readonly from?: string; readonly until?: string }): Promise<Timer[]>;
  /** The next SCHEDULED timer of a world ("Avanzar al próximo evento"). */
  nextScheduledTimer(clockId: string, after?: string): Promise<Timer | undefined>;
  /** New `dueAtSim` for a SCHEDULED timer; the version bump makes a stale schedule's firing a no-op. */
  rescheduleTimer(input: { readonly operationId: string; readonly timerKey: string; readonly dueAtSim: string; readonly reason?: string; readonly expectedVersion?: number }): Promise<Timer>;
  /** SCHEDULED → FIRED, SKIPPED or CANCELLED; leaves GSI3 and forgets its schedule. */
  completeTimer(completion: TimerCompletion): Promise<Timer>;
  /** Records (or clears, with `null`) the real schedule of a SCHEDULED timer. */
  setScheduleName(input: { readonly operationId: string; readonly timerKey: string; readonly scheduleName: string | null; readonly expectedVersion?: number }): Promise<Timer>;
}
