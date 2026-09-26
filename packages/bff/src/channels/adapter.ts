// What every channel adapter shares (docs/architecture-integrations.md §1-§4, docs/architecture.md §7):
//
//   - the transport a channel sends through (`ChannelTransport`), one per mode; channels/registry.ts
//     instantiates the one `ChannelModes` names, so nothing outside the transport knows the mode;
//   - the id of a queue event: `evt_` + 26 upper-case Crockford base32 characters, derived from the
//     event's natural key (the `Message-ID`, the `wamid`, the SES message id) so a redelivery yields
//     the same id and the FIFO plus `Runtime/IDEMP#` process it once;
//   - the events the channel entries put on `OperationEvents.fifo` (`INTAKE_DOCUMENT`, `AGENT_TURN`,
//     `ESCALATE`, `EMAIL_EVENT`), validated with zod on both sides of the queue, and the sink port that
//     adds each one to the operation's and the world's `inFlight` before sending it.
import { z } from "zod";
import {
  ChannelMode,
  ClockId,
  ContactId,
  DocType,
  DocumentSourceChannel,
  EscalationReason,
  FirmId,
  MessageId,
  OperationEventType,
  OperationId,
  Party,
  SendChannel,
  TurnTrigger,
} from "@legajo/shared";
import { HexHash, S3Key, ZonedInstant } from "../domain/common";
import { MAX_DOCUMENT_BYTES } from "../domain/documents";
import { sha256Hex } from "../lib/crypto";
import type { Logger } from "../lib/log";

/** A channel's way out in one mode (SES, End User Messaging Social, or the simulated WhatsApp transport). */
export interface ChannelTransport<TRequest, TReceipt> {
  readonly channel: SendChannel;
  readonly mode: ChannelMode;
  send(request: TRequest): Promise<TReceipt>;
}

// ---- Event ids ---------------------------------------------------------------------------------

const CROCKFORD_UPPER = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const EVENT_ID_BODY_LENGTH = 26;

/** `evt_<26 Crockford>` (new or derived) or `qa-<40 hex>` (events the `QaDriver` injects). */
export const EVENT_ID_PATTERN = /^(?:evt_[0-9A-HJKMNP-TV-Z]{26}|qa-[0-9a-f]{40})$/;
export const EventId = z.string().regex(EVENT_ID_PATTERN, "expected evt_<26 Crockford base32> or qa-<40 hex>");
export type EventId = z.infer<typeof EventId>;

/**
 * Derived event id (docs/architecture.md §7): each of the first 26 bytes of
 * SHA-256("<type>#<natural key>") modulo 32, in upper-case Crockford base32.
 */
export function derivedEventId(type: OperationEventType, naturalKey: string): EventId {
  if (naturalKey.length === 0) throw new RangeError("an event id needs its natural key");
  const digest = Buffer.from(sha256Hex(`${OperationEventType.parse(type)}#${naturalKey}`), "hex");
  let body = "";
  for (let index = 0; index < EVENT_ID_BODY_LENGTH; index += 1) body += CROCKFORD_UPPER[(digest[index] ?? 0) % 32];
  return `evt_${body}`;
}

/** `AGENT_TURN` ids are derived from `<TurnTrigger>#<key>`: the `Message-ID`, the `wamid`, the upstream event id… */
export function turnEventId(trigger: TurnTrigger, key: string): EventId {
  return derivedEventId("AGENT_TURN", `${TurnTrigger.parse(trigger)}#${key}`);
}

// ---- Events of the channel entries -------------------------------------------------------------

const EventBase = z.object({
  eventId: EventId,
  operationId: OperationId,
  clockId: ClockId,
  firmId: FirmId,
  /** Simulated instant of the world when the event was born (the policy evaluates at this hour). */
  eventAtSim: ZonedInstant,
  correlationId: z.string().min(1).max(64).optional(),
});

/** Where the worker reads the PDF of an intake: never a name an outsider chose, always a key built by code. */
export const IntakeObject = z.discriminatedUnion("store", [
  /** An email attachment: the raw MIME in the inbound mail bucket and the attachment's index in it. */
  z.object({ store: z.literal("INBOUND_MAIL"), key: S3Key, attachmentIndex: z.number().int().nonnegative() }),
  z.object({ store: z.literal("UPLOADS"), key: S3Key }),
  z.object({ store: z.literal("MEDIA"), key: S3Key }),
]);
export type IntakeObject = z.infer<typeof IntakeObject>;

export const IntakeSource = z.object({
  party: Party,
  channel: DocumentSourceChannel,
  messageId: MessageId.optional(),
  contactId: ContactId.optional(),
  uploadToken: z.string().min(1).max(64).optional(),
});
export type IntakeSource = z.infer<typeof IntakeSource>;

export const IntakeDocumentEvent = EventBase.extend({
  type: z.literal("INTAKE_DOCUMENT"),
  source: IntakeSource,
  object: IntakeObject,
  sha256: HexHash,
  sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
  /** Type the sender said it was (the upload link's slot); the reader decides. */
  declaredDocType: DocType.optional(),
});
export type IntakeDocumentEvent = z.infer<typeof IntakeDocumentEvent>;

export const AgentTurnEvent = EventBase.extend({
  type: z.literal("AGENT_TURN"),
  trigger: TurnTrigger,
  /** The inbound message the turn answers (its normalized, masked body is what the envelope carries). */
  messageId: MessageId.optional(),
  /** Outbound message an email replies to (`In-Reply-To` resolved inside the same operation). */
  inReplyToMessageId: MessageId.optional(),
  /** Intakes enqueued before the turn by the same inbound (same FIFO group, processed first). */
  intakeEventIds: z.array(EventId).default([]),
});
export type AgentTurnEvent = z.infer<typeof AgentTurnEvent>;

export const EscalateEvent = EventBase.extend({
  type: z.literal("ESCALATE"),
  reason: EscalationReason,
  messageId: MessageId.optional(),
  contactId: ContactId.optional(),
});
export type EscalateEvent = z.infer<typeof EscalateEvent>;

/** SES delivery events the configuration set publishes (no `OPEN`, no `CLICK`). */
export const SesEventType = z.enum(["DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY", "RENDERING_FAILURE"]);
export type SesEventType = z.infer<typeof SesEventType>;

export const BounceType = z.enum(["Permanent", "Transient", "Undetermined"]);
export type BounceType = z.infer<typeof BounceType>;

export const EmailEventEvent = EventBase.extend({
  type: z.literal("EMAIL_EVENT"),
  messageId: MessageId,
  sesEventType: SesEventType,
  bounceType: BounceType.optional(),
  occurredAtReal: ZonedInstant,
});
export type EmailEventEvent = z.infer<typeof EmailEventEvent>;

export const ChannelEvent = z.discriminatedUnion("type", [IntakeDocumentEvent, AgentTurnEvent, EscalateEvent, EmailEventEvent]);
export type ChannelEvent = z.infer<typeof ChannelEvent>;
export type ChannelEventInput = z.input<typeof ChannelEvent>;

/**
 * Producer side of `OperationEvents.fifo`: `ADD` of the event id to `OPSTATE#<operationId>` and
 * `WORLDSTATE#<clockId>` first, then `SendMessage` with `MessageGroupId = operationId` and
 * `MessageDeduplicationId = eventId` (docs/architecture.md §7). Resolves once both are done.
 */
export interface ChannelEventSink {
  enqueue(event: ChannelEvent): Promise<void>;
}

/** Validates an event before it leaves the adapter: a malformed event is a bug, never a queue message. */
export function channelEvent(event: ChannelEventInput): ChannelEvent {
  return ChannelEvent.parse(event);
}

// ---- Metrics -----------------------------------------------------------------------------------

/**
 * One log line per occurrence, which a metric filter of infra/observability.ts turns into
 * `LegajoAgent/<metric>` (docs/architecture.md §12). No row of the audit log per attempt.
 */
export function countMetric(log: Logger, metric: string, fields: Readonly<Record<string, unknown>> = {}): void {
  log.warn(`metric ${metric}`, { ...fields, metric });
}
