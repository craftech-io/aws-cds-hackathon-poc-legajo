// Step 7 of the pipeline (pipeline.ts): a send the policy allowed and whose content passed goes out.
// The `Message OUT` is written `QUEUED` first, then the `ALLOW` with every rule evaluated (so every
// message that ever leaves has its decision, `PolicyAudit` check a), then the transport: the single SES
// client with the SYSTEM profile (its fence runs again inside), or the WhatsApp transport of the world
// (always the simulated one in a guest world, ADR-0015 §4). The message ends `SENT` (`DELIVERED` for
// the simulated transport, which records Meta's statuses itself) with the provider's id, or `FAILED`
// with an `ACTION SEND_FAILED`; nothing is retried here (a send that may have reached the party is
// never repeated blindly).
import { ChannelError, type Guardrail, fail, toToolFailure } from "@legajo/shared";
import { countMetric } from "../channels/adapter";
import { EMAIL_METRICS } from "../channels/email/config";
import type { Message } from "../domain/conversations";
import type { PolicyDecision } from "../policy/types";
import type { SendContext } from "./context";
import type { OutboundDeps } from "./deps";
import { actionOf, messageRef, outboundMessage, recordDecision } from "./persist";
import type { RenderedSend } from "./prepare";
import { OUTBOUND_REASON, type OutboundCall, type OutboundRequest, type OutboundResult } from "./types";

export interface DeliveryInput {
  readonly request: OutboundRequest;
  readonly context: SendContext;
  readonly decision: PolicyDecision;
  readonly messageId: string;
  readonly rendered: RenderedSend;
  readonly guardrail?: Guardrail;
  /** A deferred send firing at the instant it was planned for: its row is updated in place. */
  readonly existing?: Message;
}

interface Transported {
  readonly providerMessageId: string;
  readonly status: "SENT" | "DELIVERED";
  readonly rfcMessageId?: string;
  readonly mailId?: string;
}

async function transport(deps: OutboundDeps, input: DeliveryInput): Promise<Transported> {
  const { rendered, context, request, messageId } = input;
  const { operation } = context;
  if (rendered.whatsapp !== undefined) {
    const sent = await rendered.whatsapp.route.transport.send({ message: rendered.whatsapp.message, record: { operationId: operation.operationId, clockId: operation.clockId, messageId } });
    return { providerMessageId: sent.providerMessageId, status: sent.status };
  }
  if (rendered.email === undefined) throw new ChannelError("INVALID", "EMAIL", "nothing rendered to send");
  const result = await deps.email.send({
    profile: "SYSTEM",
    ...rendered.email,
    clockId: operation.clockId,
    firmId: operation.firmId,
    operationId: operation.operationId,
    messageId,
    kind: request.kind,
    actor: request.author,
  });
  if (result.status === "REFUSED") throw new ChannelError("INVALID", "EMAIL", `the SES client refused the send (${result.reason})`, { retryable: false, cause: result });
  return { providerMessageId: result.providerMessageId, status: "SENT", rfcMessageId: result.rfcMessageId, ...(result.mailId === undefined ? {} : { mailId: result.mailId }) };
}

/** The failure a refused email answers: the fence's own code, never a generic one. */
function failureOf(error: unknown): ReturnType<typeof fail> {
  if (error instanceof ChannelError && typeof error.cause === "object" && error.cause !== null && "code" in error.cause) {
    const refusal = error.cause as { code: "INVALID" | "RECIPIENT_NOT_ALLOWED"; reason: string };
    return fail(refusal.code, `the recipient fence refused the email (${refusal.reason})`, refusal.reason);
  }
  return toToolFailure(error);
}

export async function deliver(deps: OutboundDeps, call: OutboundCall, input: DeliveryInput): Promise<OutboundResult> {
  const { request, context, decision, messageId, rendered } = input;
  const row =
    input.existing === undefined
      ? await deps.data.conversations.appendMessage(outboundMessage({ messageId, request, context, content: rendered.content, status: "QUEUED", decision, sentAtReal: deps.wallClock().toISOString() }))
      : await deps.data.conversations.updateMessage(messageRef(input.existing), { status: "QUEUED", policy: { decision: "ALLOW", ruleIds: [...decision.ruleIds] } });
  const ref = messageRef(row);
  await recordDecision(deps, call, request, context, {
    decision: "ALLOW",
    action: actionOf(request),
    policy: decision,
    messageId,
    detail: {
      ...(input.guardrail?.groundingScore === undefined ? {} : { groundingScore: input.guardrail.groundingScore }),
      ...(rendered.content.template === undefined ? {} : { template: rendered.content.template.name }),
      simulated: rendered.content.simulated,
      ...(input.existing?.deferredTimerKey === undefined ? {} : { deferredTimerKey: input.existing.deferredTimerKey }),
    },
  });
  let sent: Transported;
  try {
    sent = await transport(deps, input);
  } catch (error) {
    await deps.data.conversations.updateMessage(ref, { status: "FAILED" });
    await recordDecision(deps, call, request, context, { decision: "ACTION", action: "SEND_FAILED", messageId, reason: OUTBOUND_REASON.SEND_FAILED, detail: { error: error instanceof Error ? error.name : "unknown" } });
    call.log.error("outbound.send_failed", { messageId, error });
    return { status: "REFUSED", failure: failureOf(error), ruleIds: [], decision, ...(input.guardrail === undefined ? {} : { guardrail: input.guardrail }) };
  }
  await deps.data.conversations.updateMessage(ref, {
    status: sent.status,
    providerMessageId: sent.providerMessageId,
    ...(sent.rfcMessageId === undefined ? {} : { rfcMessageId: sent.rfcMessageId }),
    ...(sent.mailId === undefined ? {} : { mailId: sent.mailId }),
  });
  if (rendered.whatsapp !== undefined) countMetric(call.log, EMAIL_METRICS.outboundSent, { channel: "WHATSAPP", kind: request.kind, simulated: rendered.content.simulated });
  call.log.info("outbound.sent", { messageId, channel: request.channel, kind: request.kind });
  return {
    status: "SENT",
    messageId,
    providerMessageId: sent.providerMessageId,
    decision,
    ...(input.guardrail === undefined ? {} : { guardrail: input.guardrail }),
    ...(decision.window === undefined ? {} : { window: decision.window }),
    ...(rendered.content.template === undefined ? {} : { templateUsed: rendered.content.template.name }),
  };
}
