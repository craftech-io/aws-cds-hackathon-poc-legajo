// The events of `OperationEvents.fifo` as the `OperationWorker` reads them (docs/architecture.md §7):
// the four the channel entries produce (channels/adapter.ts) and the six the rest of the stage does,
// validated with zod on both sides of the queue. Producers import `OperationQueueEvent` (or the
// schema of their type) from here and enqueue through worker/sink.ts.
//
//   INTAKE_DOCUMENT  InboundEmail, InboundWhatsApp, DocumentIntake (channels/adapter.ts)
//   AGENT_TURN       every trigger of docs/design-brief.md §5.1; the intake adds the versions it read,
//                    a milestone its name and timer, so the envelope and the fallback know them
//   TIMER            ScheduleDispatch and `advance_clock`: `{clockId, operationId, timerKey, dueAtSim, version}`
//   ETA_CHANGED      FeedEvents (CarrierEtaChanged)
//   DISPATCH_STATUS  FeedEvents (CustomsStatusChanged)
//   EMAIL_EVENT      ChannelEvents (channels/adapter.ts)
//   OUTBOUND_SEND    Bff (`broker_send`, `legajo_aprobado`), QaDriver and the worker's own fixed reply
//   ESCALATE         InboundEmail (`UNTRUSTED_SENDER`), InboundWhatsApp (`OPTED_OUT`) (channels/adapter.ts)
//   HEALTH_PROBE     QaDriver (`SMK/3`): no operation, its own FIFO group
//   POISON           QaDriver, only `qa-*` clocks
import { z } from "zod";
import {
  ClockId,
  CustomsChannel,
  DispatchStatus,
  DocVersionId,
  MessageId,
  MessageKind,
  MilestoneName,
  OperationEventType,
  SendChannel,
  TimerFiredBy,
  parseClockId,
} from "@legajo/shared";
import { AgentTurnEvent, EmailEventEvent, EscalateEvent, EventId, IntakeDocumentEvent } from "../channels/adapter";
import { Actor, ZonedInstant } from "../domain/common";
import { TemplateUse } from "../domain/conversations";

export { AgentTurnEvent, EmailEventEvent, EscalateEvent, IntakeDocumentEvent } from "../channels/adapter";

/** `maxReceiveCount` of the redrive policy (infra/operations.ts `OPERATION_EVENTS`): the last attempt. */
export const MAX_RECEIVE_COUNT = 2;

/** Fields every event of an operation carries (the same as the channel events'). */
export const OperationEventBase = IntakeDocumentEvent.pick({ eventId: true, operationId: true, clockId: true, firmId: true, eventAtSim: true, correlationId: true });

/** Events the `QaDriver` injects carry `qa-<40 hex>` ids, so `dlq.*` never touches a real one. */
const QaEventId = z.string().regex(/^qa-[0-9a-f]{40}$/, "expected qa-<40 hex>");

/**
 * `AGENT_TURN` as the worker reads it: the channel's event plus what other producers know. The intake
 * names the versions it read (`DOCUMENT_READ`, `UPLOAD_COMPLETED`), a milestone its name and timer
 * (`MILESTONE`, `FOLLOWUP_DUE`).
 */
export const TurnEvent = AgentTurnEvent.extend({
  docVersionIds: z.array(DocVersionId).max(20).default([]),
  milestone: MilestoneName.optional(),
  timerKey: z.string().min(1).max(100).optional(),
});
export type TurnEvent = z.infer<typeof TurnEvent>;

/** A `TIMER#` that fell due: the input of a schedule, or what `advance_clock` dispatches. */
export const TimerEvent = OperationEventBase.extend({
  type: z.literal("TIMER"),
  timerKey: z.string().min(1).max(100),
  dueAtSim: ZonedInstant,
  /** Version of the timer when it was scheduled: a timer fired with another one is ignored. */
  version: z.number().int().min(1),
  firedBy: TimerFiredBy,
});
export type TimerEvent = z.infer<typeof TimerEvent>;

export const EtaChangedEvent = OperationEventBase.extend({
  type: z.literal("ETA_CHANGED"),
  eta: ZonedInstant,
  previousEta: ZonedInstant.optional(),
  occurredAtSim: ZonedInstant,
});
export type EtaChangedEvent = z.infer<typeof EtaChangedEvent>;

export const DispatchStatusEvent = OperationEventBase.extend({
  type: z.literal("DISPATCH_STATUS"),
  status: DispatchStatus.exclude(["NONE"]),
  channel: CustomsChannel.optional(),
  occurredAtSim: ZonedInstant,
});
export type DispatchStatusEvent = z.infer<typeof DispatchStatusEvent>;

/**
 * A send the worker runs through the outbound pipeline with a fixed author: a message of the firm, the
 * approval notice, or the worker's own fixed reply to a blocked importer message. Exactly one of
 * `text` (inside the 24-hour window) or `template` (an approved template).
 */
export const OutboundSendEvent = OperationEventBase.extend({
  type: z.literal("OUTBOUND_SEND"),
  author: Actor,
  kind: MessageKind,
  channel: SendChannel,
  text: z.string().trim().min(1).max(4_096).optional(),
  template: TemplateUse.optional(),
  /** The importer message this send answers (`REPLY`: exempt from hours, inside the window it opened). */
  inReplyToMessageId: MessageId.optional(),
}).refine((event) => (event.text === undefined) !== (event.template === undefined), "an outbound send carries text or a template, not both");
export type OutboundSendEvent = z.infer<typeof OutboundSendEvent>;

/** `GET /v1/health` of the reader with the worker's role; the result lands in `Runtime/PROBE#<probeId>`. */
export const HealthProbeEvent = z.object({
  type: z.literal("HEALTH_PROBE"),
  eventId: QaEventId,
  probeId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "expected a probe id"),
  correlationId: z.string().min(1).max(64).optional(),
});
export type HealthProbeEvent = z.infer<typeof HealthProbeEvent>;

/** An event that fails on purpose (FL-098), only in a scenario world. */
export const PoisonEvent = OperationEventBase.extend({
  type: z.literal("POISON"),
  eventId: QaEventId,
  clockId: ClockId.refine((clockId) => parseClockId(clockId)?.scope === "QA", "POISON only runs in qa-* worlds"),
});
export type PoisonEvent = z.infer<typeof PoisonEvent>;

export const OperationQueueEvent = z.discriminatedUnion("type", [
  IntakeDocumentEvent,
  TurnEvent,
  TimerEvent,
  EtaChangedEvent,
  DispatchStatusEvent,
  EmailEventEvent,
  OutboundSendEvent,
  EscalateEvent,
  HealthProbeEvent,
  PoisonEvent,
]);
export type OperationQueueEvent = z.infer<typeof OperationQueueEvent>;
export type OperationQueueEventInput = z.input<typeof OperationQueueEvent>;

/** An event of an operation (every type but `HEALTH_PROBE`). */
export type OperationScopedEvent = Exclude<OperationQueueEvent, HealthProbeEvent>;

export function isOperationScoped(event: OperationQueueEvent): event is OperationScopedEvent {
  return event.type !== "HEALTH_PROBE";
}

/** The FIFO group: the operation (its events run one at a time, in order), or a probe's own group. */
export function messageGroupOf(event: OperationQueueEvent): string {
  return isOperationScoped(event) ? event.operationId : "health-probe";
}

/** The body of a queue message that does not parse: a bug of its producer, never retried into a turn. */
export class MalformedEventError extends Error {
  override readonly name = "MalformedEventError";
}

/** What a body says about itself before validation: enough to take a lost event out of `inFlight`. */
export const LooseIdentity = z
  .object({
    type: OperationEventType.optional(),
    eventId: EventId.optional(),
    operationId: z.string().min(1).max(64).optional(),
    clockId: z.string().min(1).max(128).optional(),
    firmId: z.string().min(1).max(64).optional(),
    eventAtSim: z.string().min(1).max(64).optional(),
  })
  .loose();
export type LooseIdentity = z.infer<typeof LooseIdentity>;

function json(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new MalformedEventError("the queue message is not JSON");
  }
}

export function parseQueueEvent(body: string): OperationQueueEvent {
  const parsed = OperationQueueEvent.safeParse(json(body));
  if (!parsed.success) throw new MalformedEventError(`the queue message is not an event: ${parsed.error.issues.map((issue) => issue.path.join(".") || "(event)").join(", ")}`);
  return parsed.data;
}

/** Best-effort identity of any body (the event may not validate); never throws. */
export function looseIdentity(body: string): LooseIdentity {
  try {
    const parsed = LooseIdentity.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
