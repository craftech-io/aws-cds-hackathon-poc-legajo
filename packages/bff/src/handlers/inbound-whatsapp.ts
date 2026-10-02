// Lambda entry of `InboundWhatsApp` (docs/architecture-integrations.md §4): subscribed by
// infra/messaging-whatsapp.ts to the End User Messaging Social topic (live) and invoked by the phone
// simulator with the same SNS shape and an HMAC-signed envelope (simulated). The adapter's order
// (mode gate of the envelope, `statuses[]`, identity by registered phone, rate limit, opt-out keywords
// and buttons, nonces, routing by operation or `OPERATION_CHOICE`, media with its malware-scan
// rendezvous, the turn) is channels/whatsapp/inbound.ts; this entry wires its ports to the stage:
//
//   events     `OperationEvents.fifo` (worker/sink.ts: `inFlight` first, then `SendMessage`)
//   replies    the outbound pipeline for the fixed texts of copy/ (`author SYSTEM`, `textSource CODE`):
//              policy, transport, `Message OUT` and `AuditLog` as for any other send (ADR-0011)
//   services   `revoke_consent` and `confirm_supplier_contact` with principal `channel`
//              (services/contacts/channel-services.ts)
//
// The summary goes back to the caller: the phone simulator reads which operation and message a tap became.
import { ToolError } from "@legajo/shared";
import { stageInboundWhatsAppDeps } from "../channels/whatsapp/adapter";
import { type InboundSummary, processWhatsAppEvent } from "../channels/whatsapp/inbound";
import { systemReplyMessage } from "../channels/whatsapp/meta-message";
import type { SystemReplies, SystemReplyRequest, WhatsAppInboundDeps } from "../channels/whatsapp/ports";
import { type Connector, connector } from "../connector/index";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";
import { deliver } from "../outbound/deliver";
import type { OutboundDeps } from "../outbound/deps";
import { decide, refusePolicy, sendOutbound } from "../outbound/pipeline";
import { stageOutboundDeps } from "../outbound/stage";
import type { OutboundCall, OutboundResult, WhatsAppSend } from "../outbound/types";
import { channelServices } from "../services/contacts/channel-services";
import { type ServicePorts, stageServiceDeps } from "../services/operations-admin/ports";
import { type OperationEventSink, linkedQueueSink } from "../worker/sink";

type ReplyStatus = Awaited<ReturnType<SystemReplies["reply"]>>["status"];

function statusOf(result: OutboundResult): ReplyStatus {
  return result.status === "REFUSED" ? "DENIED" : result.status;
}

/** The pipeline request of a fixed reply: a code text answering the importer's message (exempt from hours). */
export function systemReplyRequest(request: SystemReplyRequest): WhatsAppSend {
  return {
    channel: "WHATSAPP",
    operationId: request.operationId,
    kind: request.kind,
    author: "SYSTEM",
    textSource: "CODE",
    eventAtSim: request.atSim,
    trigger: "IMPORTER_MESSAGE",
    answers: request.inReplyTo.messageId,
    messageId: request.messageId,
    text: request.body,
  };
}

/**
 * `OPERATION_CHOICE` is an interactive list whose rows carry the nonces the adapter already issued:
 * the pipeline decides it like any reply (context, fence, policy) and delivers the list as rendered
 * here (channels/whatsapp/meta-message.ts `systemReplyMessage`), never another message.
 */
async function sendChoiceList(deps: OutboundDeps, request: SystemReplyRequest, call: OutboundCall): Promise<ReplyStatus> {
  const send = systemReplyRequest(request);
  const existing = await deps.data.conversations.getMessage(request.operationId, request.messageId);
  if (existing !== undefined) return existing.status === "FAILED" ? "DENIED" : "SENT";
  const { context, decision } = await decide(deps, call, send, request.messageId);
  if (decision.outcome !== "ALLOW") {
    await refusePolicy(deps, call, send, context, decision);
    return decision.outcome === "DEFER" ? "DEFERRED" : "DENIED";
  }
  const phone = context.importer?.phoneE164;
  if (phone === undefined) throw new ToolError("NOT_FOUND", "the importer of the operation has no registered phone");
  const route = deps.whatsapp(context.operation.clockId);
  const rendered = {
    content: { to: phone, from: route.from, body: request.body, buttons: [...request.buttons], simulated: route.mode === "simulated" },
    whatsapp: { message: systemReplyMessage(request, phone), route },
  };
  return statusOf(await deliver(deps, call, { request: send, context, decision, messageId: request.messageId, rendered }));
}

/** `SystemReplies` over the outbound pipeline (channels/whatsapp/ports.ts). */
export function pipelineSystemReplies(deps: OutboundDeps, log: Logger): SystemReplies {
  return {
    async reply(request) {
      const call: OutboundCall = { actor: "SYSTEM", correlationId: request.inReplyTo.messageId, log, refs: { operationId: request.operationId, messageId: request.inReplyTo.messageId } };
      if (request.list !== undefined) return { status: await sendChoiceList(deps, request, call) };
      return { status: statusOf(await sendOutbound(deps, systemReplyRequest(request), call)) };
    },
  };
}

/** The ports `InboundWhatsApp` hosts: it asks for no approval and re-decides no deferred send. */
function channelPorts(data: Connector, events: OperationEventSink, log: Logger): ServicePorts {
  const notHosted = (what: string) => () => Promise.reject(new ToolError("UNAVAILABLE", `${what} does not run in InboundWhatsApp`));
  return {
    events,
    timers: { data, scheduler: { put: notHosted("a schedule"), delete: notHosted("a schedule") }, dispatcher: { dispatch: notHosted("a timer") }, realClock: () => new Date(), log },
    approvals: { requestApproval: notHosted("request_approval") },
    deferred: { resend: notHosted("a deferred send") },
  };
}

export type InboundWhatsAppHandler = (event: unknown) => Promise<InboundSummary>;

export function createInboundWhatsAppHandler(depsFor: (log: Logger) => WhatsAppInboundDeps, newLog: () => Logger = () => createLogger({ correlationId: newCorrelationId(), bindings: { service: "inbound-whatsapp" } })): InboundWhatsAppHandler {
  return async (event) => {
    const log = newLog();
    const summary = await processWhatsAppEvent(event, depsFor(log));
    log.info("inbound_whatsapp.done", { records: summary.records.length, accepted: summary.records.filter((record) => record.accepted).length });
    return summary;
  };
}

function stageDeps(log: Logger): WhatsAppInboundDeps {
  const data = connector();
  const events = linkedQueueSink(data.world);
  return stageInboundWhatsAppDeps({
    log,
    data,
    events,
    replies: pipelineSystemReplies(stageOutboundDeps(log, { data }), log),
    services: channelServices(stageServiceDeps(channelPorts(data, events, log))),
  });
}

export const handler: InboundWhatsAppHandler = createInboundWhatsAppHandler(stageDeps);
