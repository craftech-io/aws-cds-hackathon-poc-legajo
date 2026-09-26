// `Conversations` table (docs/architecture.md §5): messages in and out of an operation (body already
// normalized and masked), delivery events, the Harness's turn notes (never sent) and the demo
// mailboxes of the firms. `counterpartKey` + `sentAtSim` (GSI2) is what the daily frequency and the
// 24-hour window read; `providerMessageId` (GSI1) is what delivery events and `SimMail` look up.
import { z } from "zod";
import {
  AuditDecision,
  Channel,
  ClockId,
  ContactId,
  DocType,
  DocVersionId,
  FirmId,
  ImporterId,
  MessageDirection,
  MessageId,
  MessageKind,
  ObservationId,
  OperationId,
  RuleId,
  TurnTrigger,
  WaButtonAction,
  WhatsAppTemplateName,
} from "@legajo/shared";
import { Actor, EmailAddress, JsonObject, NonEmptyText, S3Key, ZonedInstant, defineEntity } from "./common";

/** Conversations keep 90 days (docs/architecture.md §5); QA worlds expire earlier. */
export const CONVERSATION_TTL_SECONDS = 90 * 24 * 60 * 60;

export const MessageStatus = z.enum([
  "RECEIVED",
  "QUEUED",
  "DEFERRED",
  "SENT",
  "DELIVERED",
  "READ",
  "DELAYED",
  "FAILED",
  "BOUNCED",
  "COMPLAINED",
  "QUARANTINED",
  "DISCARDED",
]);
export type MessageStatus = z.infer<typeof MessageStatus>;

/** The other side of the message: the importer, the supplier, or the firm's own mailbox (escalations). */
export const Counterpart = z.enum(["IMPORTER", "SUPPLIER", "FIRM"]);
export type Counterpart = z.infer<typeof Counterpart>;

export const MessageAttachment = z.object({
  index: z.number().int().nonnegative(),
  /** Kept for the record; never reaches the model (docs/architecture.md §13). */
  filename: z.string().max(255).optional(),
  contentType: z.string().max(128),
  sizeBytes: z.number().int().nonnegative(),
  status: z.enum(["ACCEPTED", "REJECTED", "QUARANTINED"]),
  reason: z.string().max(200).optional(),
  docVersionId: DocVersionId.optional(),
  s3Key: S3Key.optional(),
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

export const TemplateUse = z.object({ name: WhatsAppTemplateName, params: z.array(z.string().max(1024)) });
export type TemplateUse = z.infer<typeof TemplateUse>;

/** A button as sent: its action, the title the code wrote and the nonce that stands for it. */
export const MessageButton = z.object({
  action: WaButtonAction,
  title: z.string().min(1).max(25),
  nonce: z.string().min(1).max(64).optional(),
  url: z.string().url().optional(),
});
export type MessageButton = z.infer<typeof MessageButton>;

export const MessagePolicy = z.object({
  decision: AuditDecision,
  ruleIds: z.array(RuleId).default([]),
  nextAllowedAt: ZonedInstant.optional(),
});
export type MessagePolicy = z.infer<typeof MessagePolicy>;

export const MessageRefs = z.object({
  docTypes: z.array(DocType).optional(),
  observationIds: z.array(ObservationId).optional(),
});

export const Message = defineEntity({
  messageId: MessageId,
  operationId: OperationId,
  firmId: FirmId,
  clockId: ClockId,
  direction: MessageDirection,
  channel: Channel,
  kind: MessageKind.optional(),
  counterpart: Counterpart,
  importerId: ImporterId.optional(),
  contactId: ContactId.optional(),
  /** Address as delivered (E.164 or email); only the console shows it, masked. */
  to: z.string().min(1).max(320),
  from: z.string().min(1).max(320),
  /** Normalized and masked text (inbound) or exactly what was sent (outbound). */
  body: z.string().max(20_000),
  subject: z.string().max(998).optional(),
  template: TemplateUse.optional(),
  buttons: z.array(MessageButton).default([]),
  interactive: JsonObject.optional(),
  status: MessageStatus,
  providerMessageId: z.string().min(1).max(256).optional(),
  rfcMessageId: z.string().min(1).max(998).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.array(z.string().max(998)).default([]),
  policy: MessagePolicy.optional(),
  author: Actor,
  turnId: z.string().min(1).max(64).optional(),
  /** Inbound only: the sender passed the identity checks (`dmarcVerdict PASS`, registered contact). */
  trusted: z.boolean().default(false),
  simulated: z.boolean().default(false),
  /** Simulated time of the event that produced the message (canonical UTC; range key of GSI2). */
  sentAtSim: ZonedInstant,
  sentAtReal: ZonedInstant,
  attachments: z.array(MessageAttachment).default([]),
  refs: MessageRefs.default({}),
  /** `X-Legajo-Mail-Id` of an outbound email (pending mail, docs/architecture.md §7). */
  mailId: z.string().min(1).max(64).optional(),
  deferredTimerKey: z.string().min(1).max(100).optional(),
  truncated: z.boolean().default(false),
});
export type Message = z.output<typeof Message>;

/** Delivery statuses of an outbound message, as SES or WhatsApp (or their simulators) report them. */
export const MessageEventType = z.enum(["SENT", "DELIVERED", "READ", "DELAYED", "FAILED", "BOUNCED", "COMPLAINED", "REJECTED", "RENDERING_FAILURE"]);
export type MessageEventType = z.infer<typeof MessageEventType>;

export const MessageEvent = defineEntity({
  eventId: z.string().min(1).max(128),
  operationId: OperationId,
  clockId: ClockId,
  messageId: MessageId,
  type: MessageEventType,
  atReal: ZonedInstant,
  atSim: ZonedInstant.optional(),
  bounceType: z.enum(["Permanent", "Transient", "Undetermined"]).optional(),
  detail: JsonObject.default({}),
  simulated: z.boolean().default(false),
});
export type MessageEvent = z.output<typeof MessageEvent>;

export const TokenUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.output<typeof TokenUsage>;

/** Final text of a turn: internal note for the timeline, never sent (ADR-0011). */
export const TurnNote = defineEntity({
  turnId: z.string().min(1).max(64),
  operationId: OperationId,
  clockId: ClockId,
  trigger: TurnTrigger,
  text: z.string().max(4_000),
  atSim: ZonedInstant,
  atReal: ZonedInstant,
  usage: TokenUsage.optional(),
  stopReason: z.string().max(64).optional(),
});
export type TurnNote = z.output<typeof TurnNote>;

/** Email received by a firm's demo mailbox (`MAILBOX#<address>`); shown as plain text only. */
export const MailboxMessage = defineEntity({
  mailboxAddress: EmailAddress,
  mailboxMessageId: NonEmptyText,
  /** Firm of the operation of the verified outbound message: the console filters by this, never by address. */
  firmId: FirmId,
  operationId: OperationId.optional(),
  clockId: ClockId.optional(),
  from: z.string().min(1).max(320),
  to: z.string().min(1).max(320),
  subject: z.string().max(998),
  bodyText: z.string().max(20_000),
  receivedAtReal: ZonedInstant,
  receivedAtSim: ZonedInstant.optional(),
  sesMessageId: z.string().max(256).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.array(z.string().max(998)).default([]),
});
export type MailboxMessage = z.output<typeof MailboxMessage>;
