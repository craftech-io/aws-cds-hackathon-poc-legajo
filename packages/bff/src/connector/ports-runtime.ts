// Connector ports of what moves around the dossier (docs/build-plan.md WP-07): conversations and
// mailboxes, the decision log, the reference catalogs, per-turn runtime state, world state (clocks,
// epochs, in-flight sets, pending mails and scans, leases, tombstones) and metrics.
import type { AuditDecision, DispatchStatus, OperationEventType, WhatsAppTemplateName } from "@legajo/shared";
import type { Decision } from "../domain/audit";
import type { NewEntity } from "../domain/common";
import type { MailboxMessage, Message, MessageEvent, TurnNote } from "../domain/conversations";
import type { DossierKpi, KpiCounter } from "../domain/metrics";
import type { DispatchGlossary, EvalTruth, Holiday, NameCheck, ObservationCodeLabel, RateCard, Template } from "../domain/reference";
import type { Idempotency, MailProbe, Nonce, Probe, Session, Turn, TurnResult, UploadLink } from "../domain/runtime";
import type { Clock, Lease, LeaseKind, MailPending, OpState, ScanPending, Tombstone, WorldState } from "../domain/world-state";
import type { TableName } from "../lib/resource";

export type MessagePatch = Partial<Pick<Message, "status" | "providerMessageId" | "rfcMessageId" | "policy" | "deferredTimerKey" | "mailId" | "attachments">>;

export interface MessageRef {
  readonly operationId: string;
  readonly messageId: string;
  /** Part of the sort key (`MSG#<sentAtSim>#<messageId>`). */
  readonly sentAtSim: string;
}

export interface ConversationsPort {
  /** `attribute_not_exists`: a message is written once. GSI keys are derived from the counterpart. */
  appendMessage(message: NewEntity<typeof Message>): Promise<Message>;
  getMessage(operationId: string, messageId: string): Promise<Message | undefined>;
  /** GSI1: delivery events, `In-Reply-To` and `SimMail`'s check that a mail is ours. */
  findMessageByProviderId(providerMessageId: string): Promise<Message | undefined>;
  /** Timeline of an operation in simulated order. */
  listMessages(operationId: string, options?: { readonly direction?: Message["direction"]; readonly channel?: Message["channel"] }): Promise<Message[]>;
  /** GSI2 of a counterpart (`IMP#<importerId>`, `CONTACT#<contactId>`) in `[fromSim, toSim)` (frequency and 24-hour window). */
  listCounterpartMessages(counterpartKey: string, options?: { readonly fromSim?: string; readonly toSim?: string; readonly direction?: Message["direction"] }): Promise<Message[]>;
  updateMessage(ref: MessageRef, patch: MessagePatch, expectedVersion?: number): Promise<Message>;
  /** Idempotent by `eventId`: a repeated delivery event returns `created: false`. */
  recordMessageEvent(event: NewEntity<typeof MessageEvent>): Promise<{ readonly event: MessageEvent; readonly created: boolean }>;
  listMessageEvents(operationId: string): Promise<MessageEvent[]>;
  appendTurnNote(note: NewEntity<typeof TurnNote>): Promise<TurnNote>;
  listTurnNotes(operationId: string): Promise<TurnNote[]>;
  putMailboxMessage(message: NewEntity<typeof MailboxMessage>): Promise<MailboxMessage>;
  /** Newest first. */
  listMailbox(mailboxAddress: string, options?: { readonly limit?: number }): Promise<MailboxMessage[]>;
}

/** What a caller records; the adapter derives `decisionId`, `ts`, `month` and the GSI keys. */
export type DecisionInput = Omit<NewEntity<typeof Decision>, "decisionId" | "ts" | "month">;

export interface AuditPort {
  record(decision: DecisionInput): Promise<Decision>;
  /** GSI1: the trail of an operation, in `ts` order. */
  listByOperation(operationId: string, options?: { readonly from?: string; readonly to?: string; readonly limit?: number; readonly descending?: boolean }): Promise<Decision[]>;
  /** GSI2: decisions of a firm of one kind (`VIOLATION`, `DENY`…). */
  listByDecision(firmId: string, decision: AuditDecision, options?: { readonly from?: string; readonly to?: string; readonly limit?: number }): Promise<Decision[]>;
  listByMonth(firmId: string, month: string): Promise<Decision[]>;
  /** `PolicyAudit` check (a): the `ALLOW` recorded for a sent message. */
  findAllowForMessage(operationId: string, messageId: string): Promise<Decision | undefined>;
}

export interface ReferencePort {
  listHolidays(country: string): Promise<Holiday[]>;
  getTemplate(name: WhatsAppTemplateName): Promise<Template | undefined>;
  listTemplates(): Promise<Template[]>;
  /** `scripts/channels/whatsapp-templates.ts` records what the template API returned. */
  updateTemplate(name: WhatsAppTemplateName, patch: Partial<Pick<Template, "status" | "metaTemplateId">>): Promise<Template>;
  listRateCard(): Promise<RateCard[]>;
  getDispatchGlossary(status: Exclude<DispatchStatus, "NONE">, channel?: DispatchGlossary["channel"]): Promise<DispatchGlossary | undefined>;
  listObservationLabels(): Promise<ObservationCodeLabel[]>;
  listEvalTruth(operationId: string): Promise<EvalTruth[]>;
  listNameChecks(): Promise<NameCheck[]>;
}

export interface RuntimePort {
  putSession(session: NewEntity<typeof Session>): Promise<Session>;
  getSession(sessionId: string): Promise<Session | undefined>;
  openTurn(turn: NewEntity<typeof Turn>): Promise<Turn>;
  getTurn(turnId: string): Promise<Turn | undefined>;
  closeTurn(turnId: string, closedAtReal: string): Promise<Turn>;
  /** Allocates the next `seq` on `TURN#<turnId>` and writes `RESULT#<tool>#<seq>` (1-hour TTL). */
  appendTurnResult(input: { readonly turnId: string; readonly tool: string; readonly output: Record<string, unknown>; readonly atReal: string }): Promise<TurnResult>;
  listTurnResults(turnId: string): Promise<TurnResult[]>;
  putNonce(nonce: NewEntity<typeof Nonce>): Promise<Nonce>;
  getNonce(nonce: string): Promise<Nonce | undefined>;
  /** Marks a nonce used; CONFLICT when it already was. */
  useNonce(nonce: string, usedAtReal: string): Promise<Nonce>;
  putUploadLink(link: NewEntity<typeof UploadLink>): Promise<UploadLink>;
  getUploadLink(token: string): Promise<UploadLink | undefined>;
  /** Counts one pre-signed POST; CONFLICT past `MAX_PRESIGNS_PER_LINK`. */
  recordPresign(token: string, atReal: string): Promise<UploadLink>;
  completeUploadLink(token: string, atReal: string): Promise<UploadLink>;
  /** `IDEMP#<source>#<id>` with `attribute_not_exists`: true the first time, false for a repeat. */
  claimIdempotency(input: { readonly source: string; readonly id: string; readonly atReal: string; readonly result?: Record<string, unknown> }): Promise<boolean>;
  getIdempotency(source: string, id: string): Promise<Idempotency | undefined>;
  /** Messages of a sender in a simulated hour of a world; returns the new count. */
  incrementRate(input: { readonly clockId: string; readonly addressHash: string; readonly simHour: string }): Promise<number>;
  /** Turns of a firm in a real hour or day (`H…`/`D…`); returns the new count. */
  incrementTurnCap(input: { readonly firmId: string; readonly window: string }): Promise<number>;
  incrementCounter(name: string, by?: number): Promise<number>;
  putProbe(probe: NewEntity<typeof Probe>): Promise<Probe>;
  getProbe(probeId: string): Promise<Probe | undefined>;
  /** Written by whoever closes a pending mail, discards included (`mail.outcome`). */
  putMailProbe(probe: NewEntity<typeof MailProbe>): Promise<MailProbe>;
  getMailProbe(mailId: string): Promise<MailProbe | undefined>;
}

/** Optional fields of a clock a patch may clear with `null` (e.g. `runningUntilReal` when pausing). */
export const CLEARABLE_CLOCK_FIELDS = ["runningUntilReal", "lastSession", "lastResetAtReal"] as const;
type ClearableClockField = (typeof CLEARABLE_CLOCK_FIELDS)[number];

export type ClockPatch = Partial<Pick<Clock, "mode" | "offsetMs" | "pausedSimNow" | "worldEpoch" | "settings" | "startAtSim">> & {
  readonly [K in ClearableClockField]?: Clock[K] | null;
};

/** A pending item as its writer supplies it: the connector stamps when it goes stale. */
export type Pending<S extends typeof MailPending | typeof ScanPending> = Omit<NewEntity<S>, "staleAtReal"> & { readonly staleAtReal?: string };

export interface InFlightEvent {
  readonly operationId: string;
  readonly clockId: string;
  readonly eventId: string;
}

export interface WorldPort {
  getClock(clockId: string): Promise<Clock>;
  findClock(clockId: string): Promise<Clock | undefined>;
  /** `attribute_not_exists`: a clock is created once and never deleted by a reset. */
  createClock(clock: NewEntity<typeof Clock>): Promise<Clock>;
  updateClock(clockId: string, patch: ClockPatch, expectedVersion?: number): Promise<Clock>;
  /** `ADD 1` on `COUNTER#EPOCH#<clockId>`: 1 only the first time, never back (ADR-0007). */
  nextEpoch(clockId: string): Promise<number>;
  currentEpoch(clockId: string): Promise<number | undefined>;
  /** `ADD` the event to `OPSTATE#` and `WORLDSTATE#` before `SendMessage` (idempotent). */
  markInFlight(event: InFlightEvent): Promise<void>;
  /** `DELETE` the event from both sets when it finished (idempotent). */
  settleInFlight(event: InFlightEvent): Promise<void>;
  /** Last attempt of a dead-lettered event: out of both sets and `processError` set, in one write. */
  recordProcessError(event: InFlightEvent & { readonly type: OperationEventType; readonly atReal: string }): Promise<void>;
  clearProcessError(operationId: string): Promise<void>;
  getOpState(operationId: string): Promise<OpState | undefined>;
  getWorldState(clockId: string): Promise<WorldState | undefined>;
  /** `staleAtReal` defaults to 10 real minutes after now (`PENDING_STALE_SECONDS`). */
  putMailPending(pending: Pending<typeof MailPending>): Promise<MailPending>;
  getMailPending(clockId: string, mailId: string): Promise<MailPending | undefined>;
  /** Deletes the pending only if its `from` matches; false when there was none to close. */
  closeMailPending(input: { readonly clockId: string; readonly mailId: string; readonly from: string }): Promise<boolean>;
  putScanPending(pending: Pending<typeof ScanPending>): Promise<ScanPending>;
  closeScanPending(clockId: string, scanKey: string): Promise<boolean>;
  listPending(clockId: string): Promise<{ readonly mails: MailPending[]; readonly scans: ScanPending[] }>;
  /** Takes a free or lapsed lease; false when someone holds it (the number is skipped, never reused blindly). */
  acquireLease(input: { readonly kind: LeaseKind; readonly value: string; readonly holder: string; readonly atReal: string }): Promise<boolean>;
  releaseLease(input: { readonly kind: LeaseKind; readonly value: string; readonly holder: string }): Promise<boolean>;
  getLease(kind: LeaseKind, value: string): Promise<Lease | undefined>;
  /** Idempotent: a second call for the same epoch keeps the first. */
  putTombstone(input: { readonly clockId: string; readonly worldEpoch: number; readonly atReal: string }): Promise<Tombstone>;
  isTombstoned(clockId: string, worldEpoch: number): Promise<boolean>;
}

export interface KpiRef {
  readonly firmId: string;
  readonly source: DossierKpi["source"];
  readonly clockId: string;
  readonly operationId: string;
}

export interface MetricsPort {
  getKpi(ref: KpiRef): Promise<DossierKpi | undefined>;
  listKpis(firmId: string, options?: { readonly source?: DossierKpi["source"]; readonly clockId?: string }): Promise<DossierKpi[]>;
  /** Atomic `ADD` of counters; creates the row on first use with `agentMode` (and `runId`). */
  incrementKpi(ref: KpiRef, deltas: Partial<Record<KpiCounter | "humanMinutes", number>>, identity: Pick<DossierKpi, "agentMode"> & Partial<Pick<DossierKpi, "runId">>): Promise<DossierKpi>;
  updateKpi(ref: KpiRef, patch: Partial<Pick<DossierKpi, "dossierStatus" | "openedAtSim" | "completedAtSim">>): Promise<DossierKpi>;
}

/** One row of a seed file or a world template: key, discriminator and the entity as generated. */
export interface SeedItem {
  readonly PK: string;
  readonly SK: string;
  readonly entity: string;
  readonly [attribute: string]: unknown;
}

/** Tables the seed loader and the world factory write; `Runtime` is born empty (docs/seed-spec.md §1). */
export type SeedTable = Exclude<TableName, "Runtime" | "ReaderCatalog" | "Platform">;

export interface SeedStore {
  /** Problems per item (`<PK>/<SK>: …`); empty when every item matches its entity schema and table. */
  validateItems(table: SeedTable, items: readonly SeedItem[]): string[];
  /** Validates every item first (nothing is written if one fails), then upserts by PK + SK. */
  loadItems(table: SeedTable, items: readonly SeedItem[]): Promise<{ readonly table: SeedTable; readonly written: number }>;
}
