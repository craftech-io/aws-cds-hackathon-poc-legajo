// What the firm reads for each code of an operation, its dossier and its timeline, in the console's
// language (texts in labels-es.ts and labels-en.ts, composed by copy/localized.ts). Shared by the three
// views of the files group (operations, dossier, escalations); a code never reaches the screen raw: an
// unknown one falls back to a generic label. Every label is read when it renders, so it follows the
// language the console is in.
import {
  type AuditDecision,
  type Channel,
  type ConversationControl,
  type CustomsChannel,
  type DispatchStatus,
  type DocStatus,
  type DocType,
  type DocumentSourceChannel,
  type DossierStatus,
  type EscalationReason,
  type MessageKind,
  MilestoneName,
  type ObservationCode,
  type ObservationSeverity,
  type ObservationStatus,
  type OperationEventType,
  type Party,
  type ReadingStatus,
  type TimerKind,
  TurnTrigger,
} from "@legajo/shared";
import type { BadgeTone } from "../../components/Badge";
import { localized } from "../../copy/localized";
import { en } from "./labels-en";
import { es } from "./labels-es";
import type { Risk } from "./risk";

const labels = localized({ es, en });

export const DOC_TYPE_ORDER: readonly DocType[] = ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"];

export const docTypeLabel: Readonly<Record<DocType, string>> = labels.docType;

export const docStatusLabel: Readonly<Record<DocStatus, string>> = labels.docStatus;

export const docStatusTone: Readonly<Record<DocStatus, BadgeTone>> = {
  MISSING: "neutral",
  RECEIVED: "info",
  WITH_OBSERVATION: "warning",
  VALID: "success",
};

export const dossierStatusLabel: Readonly<Record<DossierStatus, string>> = labels.dossierStatus;

export const dossierStatusTone: Readonly<Record<DossierStatus, BadgeTone>> = {
  OPEN: "info",
  READY_FOR_REVIEW: "brand",
  APPROVED: "success",
  REOPENED: "warning",
};

export const riskLabel: Readonly<Record<Risk, string>> = labels.risk;

export const riskTone: Readonly<Record<Risk, BadgeTone>> = {
  AT_RISK: "danger",
  ON_TRACK: "info",
  COMPLETE: "success",
};

export const partyLabel: Readonly<Record<Party, string>> = labels.party;

export const controlLabel: Readonly<Record<ConversationControl, string>> = labels.control;

export const escalationReasonLabel: Readonly<Record<EscalationReason, string>> = labels.escalationReason;

export const observationStatusLabel: Readonly<Record<ObservationStatus, string>> = labels.observationStatus;

export const observationStatusTone: Readonly<Record<ObservationStatus, BadgeTone>> = {
  OPEN: "warning",
  CORRECTION_REQUESTED: "info",
  RESOLVED: "success",
  ESCALATED: "danger",
  WAIVED_BY_BROKER: "neutral",
};

/** What the reader found, as the console names it (the reader's code stays its own, ADR-0003). */
export const observationCodeLabel: Readonly<Record<ObservationCode, string>> = labels.observationCode;

export const severityLabel: Readonly<Record<ObservationSeverity, string>> = labels.severity;

export const readingStatusLabel: Readonly<Record<ReadingStatus, string>> = labels.readingStatus;

export const versionStateLabel: Readonly<Record<string, string>> = labels.versionState;

export const sourceChannelLabel: Readonly<Record<DocumentSourceChannel, string>> = labels.sourceChannel;

export const channelLabel: Readonly<Record<Channel, string>> = labels.channel;

export const messageKindLabel: Readonly<Record<MessageKind, string>> = labels.messageKind;

export const messageStatusLabel: Readonly<Record<string, string>> = labels.messageStatus;

const timerKindLabel: Readonly<Record<TimerKind, string>> = labels.timerKind;

const milestoneLabel: Readonly<Record<MilestoneName, string>> = labels.milestone;

/** A timer as the firm names it: a milestone by its own name, anything else by its kind. */
export function timerTitle(kind: TimerKind, timerId: string): string {
  const milestone = MilestoneName.safeParse(timerId);
  return kind === "MILESTONE" && milestone.success ? milestoneLabel[milestone.data] : timerKindLabel[kind];
}

export const dispatchLabel: Readonly<Record<DispatchStatus, string>> = labels.dispatch;

export const customsChannelLabel: Readonly<Record<CustomsChannel, string>> = labels.customsChannel;

export const decisionLabel: Readonly<Record<AuditDecision, string>> = labels.decision;

export const decisionTone: Readonly<Record<AuditDecision, BadgeTone>> = {
  ALLOW: "success",
  DENY: "danger",
  DEFER: "warning",
  ACTION: "neutral",
  VIOLATION: "danger",
};

/** Actions of the audit log an operation's timeline shows; any other reads as its decision label. */
export const auditActionLabel: Readonly<Record<string, string>> = labels.auditAction;

const FIXED_ACTORS: Readonly<Record<string, string>> = labels.actor;

/** Who did it, never the broker's id: `BROKER:<id>` reads as the firm. */
export function actorLabel(actor: string): string {
  if (actor.startsWith("BROKER:")) return partyLabel.BROKER;
  return FIXED_ACTORS[actor] ?? FIXED_ACTORS.SYSTEM ?? "";
}

/** Codes a timer may carry as its reason besides a rule id; any other code is not shown. */
export const timerReasonLabel: Readonly<Record<string, string>> = labels.timerReason;

const turnTriggerLabel: Readonly<Record<TurnTrigger, string>> = labels.turnTrigger;

/** The trigger of a turn note (the timeline carries it as plain text). */
export function turnTriggerText(trigger: string): string {
  const parsed = TurnTrigger.safeParse(trigger);
  return parsed.success ? turnTriggerLabel[parsed.data] : "";
}

export const eventTypeLabel: Readonly<Record<OperationEventType, string>> = labels.eventType;
