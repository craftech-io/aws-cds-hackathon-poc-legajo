// `notify_dispatch_status` (docs/tool-catalog.md, handler of the worker for `DISPATCH_STATUS`;
// docs/architecture.md §7): deterministic, no model.
//
//   1. a dossier that is not `APPROVED` when the event runs (reopened after `FeedEvents` let it through)
//      gets `DISPATCH_BEFORE_APPROVAL` and nothing else (FL-078 b);
//   2. `META.dispatch` records the status (idempotent by the feed's `eventId`);
//   3. the importer gets the template `despacho_estado` through the outbound pipeline: `{{2}}` and `{{3}}`
//      are the generic text of `Reference/DISPATCH_GLOSSARY` (copy/dispatch-glossary.ts as fallback),
//      never advice; the message id derives from the event, so a redelivery never sends twice;
//   4. `LIBERADO` closes the operation: every `SCHEDULED` timer is cancelled (FL-077).
import { ToolError } from "@legajo/shared";
import type { Connector } from "../connector/connector";
import { DISPATCH_GLOSSARY, dispatchGlossaryKey } from "../copy/dispatch-glossary";
import type { Operation } from "../domain/operations";
import { derivedMessageId, type OutboundSender } from "../escalations/ports";
import type { OutboundResult } from "../outbound/types";
import { closeOperationTimers } from "../timers/timers";
import type { SchedulerPort } from "../timers/scheduler-client";
import type { DispatchStatusEvent } from "../worker/events";
import type { WorkerContext } from "../worker/ports";
import { recordDispatchBeforeApproval } from "./feed-events";

export interface DispatchDeps {
  readonly data: Connector;
  readonly send: OutboundSender;
  /** To delete the real schedules of the timers `LIBERADO` cancels. */
  readonly scheduler: SchedulerPort;
}

export type DispatchOutcome =
  | { readonly status: "BEFORE_APPROVAL" }
  | { readonly status: "NOTIFIED"; readonly send: OutboundResult["status"]; readonly messageId: string; readonly closedTimers: readonly string[] };

/** `{{2}}` and `{{3}}` of `despacho_estado`: the status in words and its generic explanation. */
export async function dispatchTexts(data: Pick<Connector, "reference">, event: Pick<DispatchStatusEvent, "status" | "channel">): Promise<{ readonly statusText: string; readonly explanation: string }> {
  const key = dispatchGlossaryKey(event.status, event.channel);
  if (key === undefined) throw new ToolError("INVALID", `no glossary entry for ${event.status}${event.channel === undefined ? "" : `#${event.channel}`}`);
  const reference = await data.reference.getDispatchGlossary(event.status, event.channel);
  const entry = DISPATCH_GLOSSARY[key];
  return { statusText: entry.statusText, explanation: reference?.text ?? entry.explanation };
}

/** The `Message OUT` id of the notice of one customs event. */
export function dispatchMessageId(event: Pick<DispatchStatusEvent, "operationId" | "eventId">): string {
  return derivedMessageId("DISPATCH_STATUS", event.operationId, event.eventId);
}

async function notify(deps: DispatchDeps, operation: Operation, event: DispatchStatusEvent, ctx: WorkerContext): Promise<{ readonly status: OutboundResult["status"]; readonly messageId: string }> {
  const { statusText, explanation } = await dispatchTexts(deps.data, event);
  const messageId = dispatchMessageId(event);
  const result = await deps.send(
    {
      channel: "WHATSAPP",
      operationId: operation.operationId,
      kind: "DISPATCH_STATUS",
      author: "SYSTEM",
      textSource: "CODE",
      eventAtSim: event.eventAtSim,
      template: { name: "despacho_estado", params: [operation.operationNumber, statusText, explanation] },
      messageId,
    },
    { actor: "SYSTEM", correlationId: event.correlationId ?? event.eventId, log: ctx.log, refs: { operationId: operation.operationId, eventId: event.eventId } },
  );
  return { status: result.status, messageId };
}

export async function notifyDispatchStatus(deps: DispatchDeps, event: DispatchStatusEvent, ctx: WorkerContext): Promise<DispatchOutcome> {
  const operation = await deps.data.operations.getOperation(event.operationId);
  if (operation.firmId !== event.firmId || operation.clockId !== event.clockId) throw new ToolError("FORBIDDEN", "the dispatch event does not belong to this operation's firm and world");
  if (operation.dossierStatus !== "APPROVED") {
    await recordDispatchBeforeApproval(deps.data, {
      operation,
      eventId: event.eventId,
      status: event.status,
      ...(event.channel === undefined ? {} : { channel: event.channel }),
      atSim: event.eventAtSim,
      atReal: ctx.now().toISOString(),
    });
    return { status: "BEFORE_APPROVAL" };
  }
  const recorded = await deps.data.operations.recordDispatch({
    operationId: operation.operationId,
    status: event.status,
    ...(event.channel === undefined ? {} : { channel: event.channel }),
    occurredAtSim: event.occurredAtSim,
    eventId: event.eventId,
  });
  const sent = await notify(deps, recorded, event, ctx);
  const closedTimers =
    event.status === "LIBERADO" ? await closeOperationTimers({ operationId: operation.operationId, atSim: event.eventAtSim, reason: "LIBERADO: the operation is closed" }, { data: deps.data, scheduler: deps.scheduler }) : [];
  ctx.log.info("dispatch.notified", { operationId: operation.operationId, status: event.status, send: sent.status, closedTimers: closedTimers.length });
  return { status: "NOTIFIED", send: sent.status, messageId: sent.messageId, closedTimers };
}

/** The worker's `notifyDispatchStatus` (worker/ports.ts `EventHandlers`). */
export function dispatchStatusHandler(deps: DispatchDeps): (event: DispatchStatusEvent, ctx: WorkerContext) => Promise<void> {
  return async (event, ctx) => {
    await notifyDispatchStatus(deps, event, ctx);
  };
}
