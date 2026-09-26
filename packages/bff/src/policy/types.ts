// Contract of the contact-policy engine (docs/design-brief.md §5.7, ADR-0012). Everything a rule
// needs arrives in `PolicyInput`: the engine reads no table, no linked resource and no clock of the
// machine. `clock` is the instant being judged: the world's "now" when a send is decided
// (engine.ts `evaluate`), or the instants a stored message went out when `PolicyAudit` and the seed
// invariants judge the past (as-of.ts `evaluateAsOf`). Every dated fact (control, dossier status,
// opt-in, supplier authorization, contact status) is rebuilt from its history at that instant.
import { z } from "zod";
import {
  Channel,
  ChannelMode,
  ContactId,
  ContactPolicyRuleId,
  ConversationControl,
  DossierStatus,
  ErrorCode,
  ImporterId,
  IsoInstant,
  MessageDirection,
  MessageId,
  MessageKind,
  OperationId,
  Party,
  SupplierContactStatus,
  SupplierId,
  TurnTrigger,
} from "@legajo/shared";
import type { RuleOutcome } from "../domain/audit";
import { Actor, E164, IanaZone, ZonedInstant } from "../domain/common";
import { Counterpart, MessageStatus, TemplateUse } from "../domain/conversations";
import { ControlEvent, DossierEvent } from "../domain/operations";
import { AuthorizationEvent, ConsentEvent, ContactStatusEvent } from "../domain/parties";
import { PolicyHolidays } from "./holidays";

/** `SEND`: a send being decided now, fail closed on missing facts. `AS_OF`: a past send re-judged. */
export type EvaluationMode = "SEND" | "AS_OF";

/** A `Date` or an ISO 8601 instant, read as a `Date`. */
export const PolicyInstant = z
  .union([z.date(), IsoInstant])
  .transform((value) => new Date(value instanceof Date ? value.getTime() : Date.parse(value)))
  .refine((date) => !Number.isNaN(date.getTime()), "invalid instant");

/** The message being judged. Ids and addresses come from the registry, never from the model. */
export const PolicyMessage = z.object({
  /** Its id when it already exists (a deferred send, a stored message): never counted against itself. */
  messageId: MessageId.optional(),
  channel: Channel,
  counterpart: Counterpart,
  /** Optional only so a stored message without one can be judged; a send without one fails closed. */
  kind: MessageKind.optional(),
  author: Actor,
  /** Recipient as it will be delivered: the registered phone (E.164) or email address. */
  to: z.string().min(1).max(320).optional(),
  contactId: ContactId.optional(),
  /** Free text; absent for a template-only send. */
  text: z.string().max(20_000).optional(),
  template: TemplateUse.optional(),
  /** Trigger of the turn (or of the deterministic handler) that produced the send. */
  trigger: TurnTrigger.optional(),
  /** The importer's inbound message this send answers, when the caller knows it. */
  answers: MessageId.optional(),
  /** `responsibleParty` of every observation of `refs.observationIds` (a `CORRECTION_REQUEST`). */
  responsibles: z.array(Party).optional(),
});
export type PolicyMessageInput = z.input<typeof PolicyMessage>;

export const PolicyOperation = z.object({
  operationId: OperationId,
  importerId: ImporterId,
  supplierId: SupplierId,
  /** Current values: a send decided now also honours them (the stricter of current and dated). */
  control: ConversationControl.optional(),
  dossierStatus: DossierStatus.optional(),
  controlHistory: z.array(ControlEvent).min(1),
  dossierHistory: z.array(DossierEvent).min(1),
});

export const PolicyConsent = z.object({
  revokedAt: ZonedInstant.optional(),
  history: z.array(ConsentEvent).min(1),
});

/** The importer's permission for the agent to write to the operation's supplier (`AUTH#<supplierId>`). */
export const PolicyAuthorization = z.object({
  authorized: z.boolean().optional(),
  history: z.array(AuthorizationEvent).min(1),
});

export const PolicyImporter = z.object({
  importerId: ImporterId,
  phoneE164: E164.optional(),
  /** WhatsApp opt-in; absent when the importer never gave one. */
  consent: PolicyConsent.optional(),
  /** Authorization to write to the operation's supplier; absent when never registered. */
  authorization: PolicyAuthorization.optional(),
});

export const PolicySupplier = z.object({
  supplierId: SupplierId,
  timezone: IanaZone,
});

export const PolicyContact = z.object({
  contactId: ContactId,
  supplierId: SupplierId,
  status: SupplierContactStatus.optional(),
  statusHistory: z.array(ContactStatusEvent).min(1),
});

/** A message of the same counterpart (any operation): what the 24-hour window and the daily cap read. */
export const HistoryMessage = z.object({
  messageId: MessageId,
  direction: MessageDirection,
  channel: Channel,
  counterpart: Counterpart,
  kind: MessageKind.optional(),
  status: MessageStatus,
  importerId: ImporterId.optional(),
  contactId: ContactId.optional(),
  sentAtSim: IsoInstant,
  sentAtReal: IsoInstant,
});
export type HistoryMessage = z.output<typeof HistoryMessage>;

/** The instant being judged, in the world's simulated time and in real time. */
export const PolicyClock = z.object({ simNow: PolicyInstant, realNow: PolicyInstant });

export const PolicyModes = z.object({ email: ChannelMode, whatsapp: ChannelMode });

/** Outcome of a check another module runs (the recipient fence, the foreign-links verifier). */
export const PolicyVerdict = z.object({ allowed: z.boolean(), detail: z.string().max(300).optional() });
export type PolicyVerdict = z.infer<typeof PolicyVerdict>;

export const PolicyInput = z.object({
  message: PolicyMessage,
  operation: PolicyOperation,
  importer: PolicyImporter.optional(),
  supplier: PolicySupplier.optional(),
  contact: PolicyContact.optional(),
  /** The counterpart's messages around the instant; required to decide the window and the daily cap. */
  history: z.array(HistoryMessage).optional(),
  clock: PolicyClock,
  modes: PolicyModes,
  /** `CP-RECIPIENT-FENCE` verdict of outbound/recipient-fence.ts for the sender profile and recipient. */
  fence: PolicyVerdict.optional(),
  /** `CP-NO-FOREIGN-LINKS` verdict of outbound/verify.ts for the free text. */
  foreignLinks: PolicyVerdict.optional(),
  /** National holidays of Argentina (`Reference/REF#HOLIDAY#AR`); required for WhatsApp to the importer. */
  holidays: PolicyHolidays.optional(),
});
export type PolicyInput = z.input<typeof PolicyInput>;
export type ParsedPolicyInput = z.output<typeof PolicyInput>;

/** One rule's result for one message; `next` and `zone` only on a deferral. */
export interface RuleCheck {
  readonly result: RuleOutcome;
  readonly detail: string;
  readonly next?: Date;
  readonly zone?: string;
}

/** One entry of `evaluated`, the shape `AuditLog` keeps (domain/audit.ts `EvaluatedRule`). */
export interface RuleEvaluation {
  readonly ruleId: ContactPolicyRuleId;
  readonly result: RuleOutcome;
  readonly detail: string;
}

export type PolicyOutcome = "ALLOW" | "DENY" | "DEFER";

/** Tool error code of a denial (docs/tool-catalog.md, Convenciones). */
export type PolicyErrorCode = Extract<ErrorCode, "CONTROL_BROKER" | "POLICY_DENIED" | "DEFERRED" | "TEMPLATE_REQUIRED" | "RECIPIENT_NOT_ALLOWED" | "GROUNDING_FAIL">;

export interface WindowState {
  readonly state: "OPEN" | "CLOSED";
  /** Last WhatsApp message of the importer at or before the instant. */
  readonly lastInboundAt?: string;
  readonly closesAt?: string;
}

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly allowed: boolean;
  readonly deferred: boolean;
  /** The rule that denied or deferred (every breached rule in exhaustive mode), or every rule that passed. */
  readonly ruleIds: readonly ContactPolicyRuleId[];
  readonly reason?: string;
  /** First instant every time rule allows the send, in the zone of the side that decides. */
  readonly nextAllowedAt?: string;
  readonly errorCode?: PolicyErrorCode;
  readonly evaluated: readonly RuleEvaluation[];
  /** WhatsApp to the importer: the 24-hour window at the instant. */
  readonly window?: WindowState;
  /** The send answers a WhatsApp message of the importer inside the window it opened. */
  readonly reply: boolean;
}
