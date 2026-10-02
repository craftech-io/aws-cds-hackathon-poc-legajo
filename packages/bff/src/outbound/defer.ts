// Step 6 of the pipeline (pipeline.ts) and `deferred_send` (docs/tool-catalog.md, handlers of direct
// invocation; docs/design-brief.md §5.7 "Una denegación por horario no descarta el mensaje").
//
// Deferring: the timer `TIMER#DEFERRED_SEND#<messageId>` at the policy's `nextAllowedAt`, carrying the
// request (stored.ts), is armed first (its schedule only in a RUNNING world); then the `Message OUT`
// `DEFERRED`, dated at that instant and pointing at the timer; then the `DEFER` decision with its rule.
// A retry finds the timer (`CONFLICT`) or the message (pipeline.ts replay) and writes nothing twice.
//
// Firing (`resendDeferred`, the `DeferredSender` port of services/operations-admin): the policy is
// decided again at the firing instant with the same request (control, consent, authorization, contact,
// window, hours, daily cap and quota as they are then); the text is not checked again by G2 (it was
// when it was deferred, and its turn's results are gone), but what it may carry is the allowance kept
// in the timer. Then:
//   ALLOW  the same message goes out in place (deliver.ts, the row `DEFERRED` → `QUEUED` → `SENT`)
//   DEFER  deferred again under a new message id and timer; the old row ends `DISCARDED` pointing at it
//   DENY   the row ends `DISCARDED` with the `DENY` and its rule, audited as `DEFERRED_SEND`
import { ConnectorError } from "@legajo/shared";
import type { Message } from "../domain/conversations";
import { timerKeyOf } from "../domain/timers";
import type { PolicyDecision } from "../policy/types";
import type { SendContext } from "./context";
import type { OutboundDeps } from "./deps";
import { deliver } from "./deliver";
import type { LinkAllowance } from "./links";
import { actionOf, messageRef, outboundMessage, recordDecision } from "./persist";
import { decide, refusePolicy } from "./pipeline";
import { type RenderedSend, renderSend } from "./prepare";
import { deferredPayloadOf, requestOf } from "./stored";
import { decidingZone } from "./texts";
import { OUTBOUND_ACTION, OUTBOUND_REASON, type OutboundCall, type OutboundDeferred, type OutboundRequest } from "./types";

export interface DeferInput {
  readonly request: OutboundRequest;
  readonly context: SendContext;
  readonly decision: PolicyDecision;
  readonly messageId: string;
  readonly rendered: RenderedSend;
  readonly allowance: Pick<LinkAllowance, "links"> & { readonly numbers: Iterable<string> };
  readonly guardrail?: OutboundDeferred["guardrail"];
}

function isConflict(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === "CONFLICT";
}

/** The timer and the `DEFERRED` message of a send a time rule deferred. */
export async function deferSend(deps: OutboundDeps, call: OutboundCall, input: DeferInput): Promise<OutboundDeferred> {
  const { request, context, decision, messageId, rendered } = input;
  const { operation } = context;
  const nextAllowedAt = decision.nextAllowedAt;
  if (nextAllowedAt === undefined) throw new RangeError("a deferral needs the policy's nextAllowedAt");
  const timerKey = timerKeyOf("DEFERRED_SEND", messageId);
  const payload = deferredPayloadOf(request, input.allowance, rendered.uploadToken);
  try {
    await deps.arming.arm({ operationId: operation.operationId, clockId: operation.clockId, timerId: messageId, dueAtSim: nextAllowedAt, reason: decision.ruleIds[0] ?? "DEFERRED", payload });
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  try {
    await deps.data.conversations.appendMessage(
      outboundMessage({ messageId, request, context, content: rendered.content, status: "DEFERRED", decision, deferredTimerKey: timerKey, sentAtReal: deps.wallClock().toISOString(), atSim: nextAllowedAt }),
    );
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  await recordDecision(deps, call, request, context, {
    decision: "DEFER",
    action: actionOf(request),
    policy: decision,
    messageId,
    detail: { timerKey, nextAllowedAt, ...(rendered.content.template === undefined ? {} : { template: rendered.content.template.name }) },
  });
  call.log.info("outbound.deferred", { messageId, rule: decision.ruleIds[0], nextAllowedAt });
  return {
    status: "DEFERRED",
    messageId,
    decision,
    nextAllowedAt,
    zone: decidingZone(context),
    timerKey,
    ...(input.guardrail === undefined ? {} : { guardrail: input.guardrail }),
    ...(decision.window === undefined ? {} : { window: decision.window }),
  };
}

export type DeferredOutcome = "SENT" | "DEFERRED" | "DENIED";

export interface DeferredFiring {
  readonly operationId: string;
  readonly messageId: string;
  readonly timerKey: string;
  /** The firing instant (the timer's `dueAtSim`, or the world's now for "Disparar ahora"). */
  readonly atSim: string;
}

export interface DeferredResult {
  readonly status: DeferredOutcome;
  readonly nextAllowedAt?: string;
  /** The message that carries the send now (a new one when it was deferred again). */
  readonly messageId?: string;
}

/** What a message that is no longer `DEFERRED` already became (a repeated firing does nothing). */
function settledOutcome(message: Message): DeferredResult {
  if (message.status === "DISCARDED") {
    return message.policy?.decision === "DEFER" && message.policy.nextAllowedAt !== undefined ? { status: "DEFERRED", nextAllowedAt: message.policy.nextAllowedAt } : { status: "DENIED" };
  }
  return message.status === "FAILED" ? { status: "DENIED" } : { status: "SENT", messageId: message.messageId };
}

async function discardInvalid(deps: OutboundDeps, call: OutboundCall, message: Message): Promise<DeferredResult> {
  await deps.data.conversations.updateMessage(messageRef(message), { status: "DISCARDED", policy: { decision: "DENY", ruleIds: [] } });
  await deps.data.audit.record({
    firmId: message.firmId,
    decision: "DENY",
    action: OUTBOUND_ACTION.DEFERRED,
    ruleIds: [],
    actor: call.actor,
    refs: { ...(call.refs ?? {}), operationId: message.operationId, messageId: message.messageId },
    reason: OUTBOUND_REASON.DEFERRED_PAYLOAD_INVALID,
    clockId: message.clockId,
    operationId: message.operationId,
    atSim: message.sentAtSim,
    atReal: deps.wallClock().toISOString(),
    correlationId: call.correlationId.slice(0, 64),
  });
  call.log.error("outbound.deferred_payload_invalid", { messageId: message.messageId });
  return { status: "DENIED" };
}

/** `deferred_send`: the stored send decided again when its timer fires. */
export async function resendDeferred(deps: OutboundDeps, call: OutboundCall, firing: DeferredFiring): Promise<DeferredResult> {
  const log = call.log.child({ service: "outbound", step: "deferred_send" });
  const scoped: OutboundCall = { ...call, log };
  const message = await deps.data.conversations.getMessage(firing.operationId, firing.messageId);
  if (message === undefined) {
    log.warn("outbound.deferred_missing", { messageId: firing.messageId });
    return { status: "DENIED" };
  }
  if (message.status !== "DEFERRED") return settledOutcome(message);
  const timer = await deps.data.timers.findTimer(firing.operationId, firing.timerKey);
  const stored = requestOf(timer?.payload, { eventAtSim: firing.atSim, messageId: message.messageId });
  if (stored === undefined) return discardInvalid(deps, scoped, message);
  const { request, payload } = stored;
  const { context, decision, allowance } = await decide(deps, scoped, request, message.messageId, payload.allowance);
  const ref = messageRef(message);
  if (decision.outcome === "DENY") {
    await deps.data.conversations.updateMessage(ref, { status: "DISCARDED", policy: { decision: "DENY", ruleIds: [...decision.ruleIds] } });
    await refusePolicy(deps, scoped, request, context, decision, OUTBOUND_ACTION.DEFERRED);
    return { status: "DENIED" };
  }
  if (decision.outcome === "DEFER") {
    const messageId = `msg-${deps.newId()}`;
    const again: OutboundRequest = { ...request, messageId };
    const rendered = await renderSend(deps, again, context, messageId, payload.uploadToken);
    const deferred = await deferSend(deps, scoped, { request: again, context, decision, messageId, rendered, allowance });
    await deps.data.conversations.updateMessage(ref, { status: "DISCARDED", policy: { decision: "DEFER", ruleIds: [...decision.ruleIds], nextAllowedAt: deferred.nextAllowedAt }, deferredTimerKey: deferred.timerKey });
    return { status: "DEFERRED", nextAllowedAt: deferred.nextAllowedAt, messageId };
  }
  const rendered = await renderSend(deps, request, context, message.messageId, payload.uploadToken);
  const result = await deliver(deps, scoped, { request, context, decision, messageId: message.messageId, rendered, existing: message });
  return result.status === "SENT" ? { status: "SENT", messageId: message.messageId } : { status: "DENIED" };
}
