// `Operations/META` and `Operations/ESC#` (docs/architecture.md §5): the operation with its dossier
// status, control, ETA and dispatch histories, its thread address and world epoch, the supplier
// simulator's per-operation state, and the escalations to the broker.
import { z } from "zod";
import {
  BrokerId,
  CalendarDate,
  ClockId,
  ConversationControl,
  CustomsChannel,
  DispatchStatus,
  DocType,
  DocVersionId,
  DossierStatus,
  EscalationReason,
  FirmId,
  ImporterId,
  ObservationId,
  OperationId,
  OperationNumber,
  SupplierBehaviour,
  SupplierId,
  ThreadTag,
} from "@legajo/shared";
import { Actor, EmailAddress, HistoryStamp, NonEmptyText, ZonedInstant, defineEntity, entryAt } from "./common";
import { BehaviourParams } from "./parties";

export const DossierEvent = HistoryStamp.extend({ status: DossierStatus });
export type DossierEvent = z.infer<typeof DossierEvent>;

export const ControlEvent = HistoryStamp.extend({ control: ConversationControl });
export type ControlEvent = z.infer<typeof ControlEvent>;

/** Where an ETA came from: the seed, the platform at creation, a carrier event, the console or QA. */
export const EtaSource = z.enum(["SEED", "PLATFORM", "CARRIER", "CONSOLE", "QA"]);
export type EtaSource = z.infer<typeof EtaSource>;

export const EtaEvent = z.object({
  eta: ZonedInstant,
  previousEta: ZonedInstant.optional(),
  atSim: ZonedInstant,
  atReal: ZonedInstant.optional(),
  source: EtaSource,
  eventId: z.string().min(1).max(128).optional(),
});
export type EtaEvent = z.infer<typeof EtaEvent>;

export const DispatchEvent = z.object({
  status: DispatchStatus,
  channel: CustomsChannel.optional(),
  occurredAtSim: ZonedInstant,
  eventId: z.string().min(1).max(128).optional(),
});
export type DispatchEvent = z.infer<typeof DispatchEvent>;

export const Dispatch = z.object({
  status: DispatchStatus,
  channel: CustomsChannel.optional(),
  occurredAtSim: ZonedInstant.optional(),
  history: z.array(DispatchEvent).default([]),
});
export type Dispatch = z.infer<typeof Dispatch>;

/** Supplier simulator state of the operation (docs/architecture-integrations.md §3). */
export const SimState = z.object({
  repliesSent: z.number().int().nonnegative().default(0),
  /** Last version the simulator sent, per document type. */
  versionsSent: z.partialRecord(DocType, z.number().int().positive()).default({}),
  lastReplyAtSim: ZonedInstant.optional(),
  /** Loop guard: replies per simulated day and per real day. */
  repliesOnSimDay: z.object({ day: CalendarDate, count: z.number().int().nonnegative() }).optional(),
  repliesOnRealDay: z.object({ day: CalendarDate, count: z.number().int().nonnegative() }).optional(),
  /** Which of the two `INJECTION` bodies goes next. */
  injectionStep: z.number().int().nonnegative().default(0),
});
export type SimState = z.infer<typeof SimState>;

export const Operation = defineEntity({
  operationId: OperationId,
  operationNumber: OperationNumber,
  firmId: FirmId,
  clockId: ClockId,
  worldEpoch: z.number().int().min(1),
  importerId: ImporterId,
  supplierId: SupplierId,
  /** Model operation whose synthetic PDFs and ground truth this one uses (itself in the seed). */
  templateOperation: OperationId,
  vessel: NonEmptyText,
  carrier: NonEmptyText,
  regime: NonEmptyText,
  portOfLoading: NonEmptyText,
  portOfDischarge: NonEmptyText.default("Buenos Aires"),
  eta: ZonedInstant,
  etaHistory: z.array(EtaEvent).min(1),
  invoiceNumber: NonEmptyText,
  incoterm: z.string().regex(/^[A-Z]{3}$/, "expected a three-letter incoterm"),
  incotermPlace: NonEmptyText,
  dossierStatus: DossierStatus,
  dossierHistory: z.array(DossierEvent).min(1),
  control: ConversationControl,
  controlHistory: z.array(ControlEvent).min(1),
  threadAddress: EmailAddress,
  threadTag: ThreadTag,
  dispatch: Dispatch.default({ status: "NONE", history: [] }),
  /** Set by the `ARRIVAL` milestone when the dossier is incomplete at the ETA (FL-071): "en riesgo". */
  atRisk: z.boolean().optional(),
  /** Raised after every G1 block of the Harness: the next turn starts a clean session (§9.1). */
  sessionEpoch: z.number().int().nonnegative().default(0),
  /** Operation override of the supplier's simulated behaviour (QA and console). */
  simBehaviour: SupplierBehaviour.optional(),
  simBehaviourParams: BehaviourParams.optional(),
  simState: SimState.default({ repliesSent: 0, versionsSent: {}, injectionStep: 0 }),
  approvedBy: BrokerId.optional(),
  approvedAtSim: ZonedInstant.optional(),
  openedAtSim: ZonedInstant,
});
export type Operation = z.output<typeof Operation>;

/**
 * Dossier transitions. Only a human approves (ADR-0010): `APPROVED` is reached only from
 * `READY_FOR_REVIEW` through the console; the agent's `request_approval` moves to `READY_FOR_REVIEW`.
 */
export const DOSSIER_TRANSITIONS: Readonly<Record<DossierStatus, readonly DossierStatus[]>> = {
  OPEN: ["READY_FOR_REVIEW"],
  READY_FOR_REVIEW: ["APPROVED", "OPEN"],
  APPROVED: ["REOPENED"],
  REOPENED: ["READY_FOR_REVIEW"],
};

export function canTransitionDossier(from: DossierStatus, to: DossierStatus): boolean {
  return DOSSIER_TRANSITIONS[from].includes(to);
}

/** Dossier statuses the agent still works on (everything but approved). */
export const ACTIVE_DOSSIER_STATUSES: readonly DossierStatus[] = ["OPEN", "READY_FOR_REVIEW", "REOPENED"];

export function dossierStatusAt(operation: Pick<Operation, "dossierHistory">, atSim: string): DossierStatus | undefined {
  return entryAt(operation.dossierHistory, atSim)?.status;
}

export function controlAt(operation: Pick<Operation, "controlHistory">, atSim: string): ConversationControl | undefined {
  return entryAt(operation.controlHistory, atSim)?.control;
}

/** The behaviour the simulator applies to this operation: its override, else the supplier's. */
export function effectiveBehaviour(operation: Pick<Operation, "simBehaviour">, supplierBehaviour: SupplierBehaviour): SupplierBehaviour {
  return operation.simBehaviour ?? supplierBehaviour;
}

export const EscalationId = z.string().regex(/^esc-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/, "expected esc-<id>");
export type EscalationId = z.infer<typeof EscalationId>;

export const EscalationStatus = z.enum(["OPEN", "RESOLVED"]);
export type EscalationStatus = z.infer<typeof EscalationStatus>;

/** A handoff to the broker; at most one OPEN per reason and operation (docs/tool-catalog.md). */
export const Escalation = defineEntity({
  escalationId: EscalationId,
  operationId: OperationId,
  firmId: FirmId,
  clockId: ClockId,
  reason: EscalationReason,
  /** At most 500 characters, without personal data. */
  summary: z.string().max(500),
  status: EscalationStatus,
  openedAtSim: ZonedInstant,
  openedAtReal: ZonedInstant.optional(),
  openedBy: Actor,
  emailSent: z.boolean().default(false),
  notifyImporter: z.boolean().default(false),
  observationId: ObservationId.optional(),
  docVersionId: DocVersionId.optional(),
  resolvedAtSim: ZonedInstant.optional(),
  resolvedBy: Actor.optional(),
  resolution: z.string().max(500).optional(),
});
export type Escalation = z.output<typeof Escalation>;
