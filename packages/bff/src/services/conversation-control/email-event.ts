// `apply_email_event` (docs/tool-catalog.md; FL-029, FL-031): what the worker does with an `EMAIL_EVENT`
// that `ChannelEvents` enqueued for one of our outbound emails. The plan is `planEmailEvent`
// (channels/email/events.ts); this applies it, every step idempotent so a retried event converges:
//
//   1. the delivery event is recorded on the message (`MessageEvent`, idempotent by the event id);
//   2. the `Message OUT` takes its new status, unless it already reached a final one;
//   3. a permanent bounce or a complaint makes the contact `BOUNCED` / `COMPLAINED` (final: the
//      agent never writes to it again, `CP-BOUNCED-CONTACT`);
//   4. `TIMER#CONTACT_CHECK` one simulated day after a permanent bounce, `TIMER#BOUNCE_RETRY` four
//      hours after a transient one (a timer that exists is left as it is);
//   5. a permanent bounce starts a turn `EMAIL_BOUNCED` (the agent asks the importer for another
//      contact); a complaint escalates `NO_VALID_CONTACT` without a turn;
//   6. a rejection or a rendering failure is counted for the error alarm (`EmailSendFailed`);
//   7. `ACTION EMAIL_EVENT_APPLIED` once per event.
import { z } from "zod";
import { ConnectorError } from "@legajo/shared";
import { type BounceType, EmailEventEvent, type SesEventType, channelEvent, countMetric, derivedEventId, turnEventId } from "../../channels/adapter";
import { planEmailEvent } from "../../channels/email/events";
import type { MessageEventType } from "../../domain/conversations";
import { CONTACT_TRANSITIONS } from "../../domain/parties";
import { armTimer } from "../../timers/timers";
import type { WorkerContext } from "../../worker/ports";
import { type DirectContext, createDirectHandler, unwrapDirect } from "../operations-admin/handler-kit";
import type { ServiceDeps } from "../operations-admin/ports";

export const EMAIL_FAILURE_METRIC = "EmailSendFailed";

const EVENT_TYPES: Readonly<Record<SesEventType, MessageEventType>> = {
  DELIVERY: "DELIVERED",
  BOUNCE: "BOUNCED",
  COMPLAINT: "COMPLAINED",
  REJECT: "REJECTED",
  DELIVERY_DELAY: "DELAYED",
  RENDERING_FAILURE: "RENDERING_FAILURE",
};

export const ApplyEmailEventInput = z.object({ event: EmailEventEvent }).strict();

/** A transient bounce is the only one SES may still deliver; an undetermined one is treated like it. */
function bounceTypeOf(type: SesEventType, bounceType: BounceType | undefined): BounceType | undefined {
  return type === "BOUNCE" ? (bounceType ?? "Undetermined") : undefined;
}

async function armOnce(deps: ServiceDeps, spec: Parameters<typeof armTimer>[0]): Promise<boolean> {
  try {
    await armTimer(spec, deps.timers);
    return true;
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") return false;
    throw error;
  }
}

async function apply(ctx: DirectContext<z.output<typeof ApplyEmailEventInput>>, deps: ServiceDeps) {
  const { event } = ctx.input;
  const { conversations, operations, parties } = ctx.connector;
  const message = await conversations.getMessage(event.operationId, event.messageId);
  if (message === undefined || message.direction !== "OUT" || message.channel !== "EMAIL" || message.clockId !== event.clockId) {
    ctx.log.warn("email event of a message that is not an outbound email of this operation", { sesEventType: event.sesEventType });
    return { applied: false as const };
  }
  const bounceType = bounceTypeOf(event.sesEventType, event.bounceType);
  const recorded = await conversations.recordMessageEvent({
    eventId: event.eventId,
    operationId: event.operationId,
    clockId: event.clockId,
    messageId: event.messageId,
    type: EVENT_TYPES[event.sesEventType],
    atReal: event.occurredAtReal,
    atSim: event.eventAtSim,
    ...(bounceType === undefined ? {} : { bounceType }),
  });
  const plan = planEmailEvent({ type: event.sesEventType, bounceType, message, atSim: event.eventAtSim });

  if (plan.messageStatus !== undefined && plan.messageStatus !== message.status) {
    await conversations.updateMessage({ operationId: message.operationId, messageId: message.messageId, sentAtSim: message.sentAtSim }, { status: plan.messageStatus }, message.version);
  }

  let contactStatus: string | undefined;
  if (plan.contactStatus !== undefined && message.contactId !== undefined) {
    const operation = await operations.getOperation(message.operationId);
    const contact = await parties.findContact(operation.supplierId, message.contactId);
    if (contact !== undefined && CONTACT_TRANSITIONS[contact.status].includes(plan.contactStatus)) {
      await parties.transitionContact({ supplierId: contact.supplierId, contactId: contact.contactId, to: plan.contactStatus, atSim: event.eventAtSim, atReal: ctx.now().toISOString(), by: "SYSTEM", reason: event.sesEventType, expectedVersion: contact.version });
      contactStatus = plan.contactStatus;
    }
  }

  const timerArmed = plan.timer === undefined ? false : await armOnce(deps, { operationId: message.operationId, clockId: message.clockId, kind: plan.timer.kind, timerId: plan.timer.timerId, dueAtSim: plan.timer.dueAtSim, reason: event.sesEventType, payload: { messageId: message.messageId, ...(message.contactId === undefined ? {} : { contactId: message.contactId }) } });

  const base = { operationId: message.operationId, clockId: message.clockId, firmId: message.firmId, eventAtSim: event.eventAtSim, ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }) };
  if (plan.turn !== undefined) await deps.events.enqueue(channelEvent({ type: "AGENT_TURN", eventId: turnEventId(plan.turn, event.eventId), ...base, trigger: plan.turn }));
  if (plan.escalation !== undefined) {
    await deps.events.enqueue(channelEvent({ type: "ESCALATE", eventId: derivedEventId("ESCALATE", `${event.eventId}#${plan.escalation}`), ...base, reason: plan.escalation, messageId: message.messageId, ...(message.contactId === undefined ? {} : { contactId: message.contactId }) }));
  }
  if (plan.alarm) countMetric(ctx.log, EMAIL_FAILURE_METRIC, { sesEventType: event.sesEventType });

  if (recorded.created) {
    await ctx.audit({
      firmId: message.firmId,
      decision: "ACTION",
      action: "EMAIL_EVENT_APPLIED",
      clockId: message.clockId,
      operationId: message.operationId,
      atSim: event.eventAtSim,
      messageId: message.messageId,
      refs: { messageId: message.messageId, eventId: event.eventId, ...(message.contactId === undefined ? {} : { contactId: message.contactId }) },
      detail: { sesEventType: event.sesEventType, ...(bounceType === undefined ? {} : { bounceType }), ...(plan.messageStatus === undefined ? {} : { messageStatus: plan.messageStatus }), ...(contactStatus === undefined ? {} : { contactStatus }), timerArmed },
    });
  }
  return { applied: true as const, ...(plan.messageStatus === undefined ? {} : { messageStatus: plan.messageStatus }), ...(contactStatus === undefined ? {} : { contactStatus }), timerArmed, turn: plan.turn !== undefined, escalated: plan.escalation !== undefined };
}

export function applyEmailEventHandler(deps: ServiceDeps) {
  return createDirectHandler({ name: "apply_email_event", input: ApplyEmailEventInput, callers: ["WORKER"], run: (ctx) => apply(ctx, deps) }, deps);
}

/** `EventHandlers.applyEmailEvent` of the worker: the handler with `caller WORKER`; a failure goes back to the queue. */
export function workerApplyEmailEvent(deps: ServiceDeps): (event: EmailEventEvent, ctx: WorkerContext) => Promise<void> {
  const handler = applyEmailEventHandler(deps);
  return async (event, ctx) => {
    unwrapDirect(await handler({ caller: { kind: "WORKER", firmId: event.firmId, eventId: event.eventId }, event }, { correlationId: ctx.log.correlationId }));
  };
}
