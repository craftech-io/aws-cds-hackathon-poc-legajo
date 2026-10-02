// `deferred_send` (docs/tool-catalog.md; FL-033, FL-055, FL-056): a message a time rule deferred
// (`CP-HOURS-*`, `CP-WA-24H`) is decided again when its `TIMER#DEFERRED_SEND#<messageId>` falls due. The
// outbound pipeline re-runs the context, the policy and the delivery at that simulated instant and
// sends it, defers it again (a new timer at `nextAllowedAt`) or denies it (`ALLOW` / `DEFER` / `DENY`
// in the audit, written by the pipeline).
//
// The timer's claim and its own audit belong to `fire_timer` (timers/fire.ts), which calls
// `deferredSendAction` for this kind; the direct handler serves a `worker` or `scheduler` caller that
// already holds the firing. A message that is no longer `DEFERRED` under this timer (sent, denied, or
// deferred again under another one) is skipped: never sent twice.
import { z } from "zod";
import { ClockId, MessageId, OperationId } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import { ZonedInstant } from "../../domain/common";
import { timerKeyOf } from "../../domain/timers";
import type { TimerAction } from "../../timers/fire";
import { createDirectHandler } from "../operations-admin/handler-kit";
import type { DeferredOutcome, ServiceDeps } from "../operations-admin/ports";

export const DeferredSendInput = z
  .object({ operationId: OperationId, clockId: ClockId, messageId: MessageId, timerKey: z.string().min(1).max(100), atSim: ZonedInstant })
  .strict();
type DeferredSendRequest = z.output<typeof DeferredSendInput>;

export type DeferredSendResult = { readonly outcome: "SKIPPED"; readonly reason: string } | { readonly outcome: DeferredOutcome; readonly nextAllowedAt?: string };

/** Re-decides one deferred message; `SKIPPED` when the timer no longer stands for it. */
export async function runDeferredSend(data: Pick<Connector, "conversations">, deps: Pick<ServiceDeps, "deferred">, request: DeferredSendRequest & { readonly correlationId?: string }): Promise<DeferredSendResult> {
  const message = await data.conversations.getMessage(request.operationId, request.messageId);
  if (message === undefined || message.clockId !== request.clockId) return { outcome: "SKIPPED", reason: "MESSAGE_GONE" };
  if (message.status !== "DEFERRED" || message.deferredTimerKey !== request.timerKey) return { outcome: "SKIPPED", reason: "MESSAGE_NOT_DEFERRED" };
  const decided = await deps.deferred.resend({
    operationId: request.operationId,
    messageId: request.messageId,
    timerKey: request.timerKey,
    atSim: request.atSim,
    ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
  });
  return { outcome: decided.status, ...(decided.nextAllowedAt === undefined ? {} : { nextAllowedAt: decided.nextAllowedAt }) };
}

/** The `DEFERRED_SEND` action `fire_timer` runs: the timer's id is the deferred message's id. */
export function deferredSendAction(deps: Pick<ServiceDeps, "connector" | "deferred">): TimerAction {
  return async ({ timer, firing }) => {
    const result = await runDeferredSend(deps.connector, deps, {
      operationId: timer.operationId,
      clockId: timer.clockId,
      messageId: timer.timerId,
      timerKey: timerKeyOf(timer.kind, timer.timerId),
      atSim: firing.eventAtSim,
      ...(firing.correlationId === undefined ? {} : { correlationId: firing.correlationId }),
    });
    if (result.outcome === "SKIPPED") return { outcome: "SKIPPED", reason: result.reason };
    return { outcome: "FIRED", detail: { sendStatus: result.outcome, ...(result.nextAllowedAt === undefined ? {} : { nextAllowedAt: result.nextAllowedAt }) } };
  };
}

export function deferredSendHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "deferred_send",
      input: DeferredSendInput,
      callers: ["WORKER", "SCHEDULER"],
      run: (ctx) => runDeferredSend(ctx.connector, deps, { ...ctx.input, correlationId: ctx.correlationId }),
    },
    deps,
  );
}
