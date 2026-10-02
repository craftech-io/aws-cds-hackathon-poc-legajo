// `OUTBOUND_SEND` (docs/architecture.md §7; worker/events.ts): a send a deterministic handler ordered
// (`broker_send`, `approve_dossier`, the fixed `OPT_OUT_CONFIRMATION` of `revoke_consent`, the worker's
// fixed reply to a blocked importer message), which the worker hands to this pipeline in the
// operation's FIFO group. The message id derives from the event's, so a redelivered event is answered
// from the message it already wrote and never sends twice; the policy, the window, the template, the
// fence and the transport decide exactly as for any other send.
import { ToolError } from "@legajo/shared";
import { derivedMessageId } from "../channels/whatsapp/records";
import type { OutboundSendEvent } from "../worker/events";
import type { OutboundDeps } from "./deps";
import { sendOutbound } from "./pipeline";
import { OUTBOUND_REASON, type OutboundCall, type OutboundResult, type WhatsAppSend } from "./types";

/** The `Message OUT` id of an ordered send. */
export function orderedMessageId(eventId: string): string {
  return derivedMessageId(eventId, "OUTBOUND_SEND");
}

/** The pipeline request of an ordered send: a person of the firm wrote it, or it is a fixed text of copy/. */
export function orderedRequest(event: OutboundSendEvent): WhatsAppSend {
  if (event.channel !== "WHATSAPP") throw new ToolError("INVALID", "an ordered send goes to the importer by WhatsApp", OUTBOUND_REASON.CONTENT_INVALID);
  return {
    operationId: event.operationId,
    channel: "WHATSAPP",
    kind: event.kind,
    author: event.author,
    textSource: event.author.startsWith("BROKER:") ? "PERSON" : "CODE",
    eventAtSim: event.eventAtSim,
    messageId: orderedMessageId(event.eventId),
    ...(event.inReplyToMessageId === undefined ? {} : { answers: event.inReplyToMessageId }),
    ...(event.text === undefined ? {} : { text: event.text }),
    ...(event.template === undefined ? {} : { template: { name: event.template.name, params: [...event.template.params] } }),
  };
}

export function sendOrdered(deps: OutboundDeps, event: OutboundSendEvent, call: OutboundCall): Promise<OutboundResult> {
  return sendOutbound(deps, orderedRequest(event), call);
}
