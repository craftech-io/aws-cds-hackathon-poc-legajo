// The `OperationWorker` (docs/architecture.md §7): one event of `OperationEvents.fifo` at a time (batch
// 1, the events of an operation in order), dispatched by type.
//
// Double idempotency: SQS drops a repeated `MessageDeduplicationId = eventId` for 5 minutes, and
// `Runtime/IDEMP#<type>#<eventId>` (7 days) is written once the event's effect is recorded, so a
// redelivery after that is acknowledged without running again, while a delivery that failed halfway
// runs again (FL-034). An event that finished, ran before or was refused leaves `inFlight` of its
// operation and its world (`DELETE` in both sets, idempotent).
//
// An event that fails is thrown back to SQS. On its last attempt (`ApproximateReceiveCount ≥
// maxReceiveCount`) it never finishes, so before rethrowing the worker takes it out of `inFlight`,
// writes `OPSTATE#<operationId>.processError` and audits `EVENT_DEAD_LETTERED` (FL-098): `op.settle`
// and the `WORLD_BUSY` gate stop waiting for it and the console shows the operation "con error de
// proceso", while the message goes to the DLQ and its alarm. An earlier attempt leaves it in flight.
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { OperationEventType } from "@legajo/shared";
import { countMetric } from "../channels/adapter";
import type { Connector } from "../connector/index";
import type { ReaderClient } from "../reader/client";
import { correlationIdFrom, type Logger } from "../lib/log";
import type { TurnDeps } from "../turns/deps";
import { runAgentTurn } from "../turns/turn";
import { WORKER_ACTIONS, auditOnce } from "./audit";
import { escalateEvent } from "./escalation";
import { MAX_RECEIVE_COUNT, type LooseIdentity, type OperationQueueEvent, isOperationScoped, looseIdentity, parseQueueEvent } from "./events";
import type { EscalationPort, EventHandlers, WorkerContext } from "./ports";
import { type QueueVisibility, runHealthProbe, runPoison } from "./probe";
import type { OperationEventSink } from "./sink";

export const DEAD_LETTER_METRIC = "EventDeadLettered";
/** Real time kept after a turn for its writes (note, usage, audit) before the Lambda's own timeout. */
export const TURN_TAIL_MARGIN_MS = 30_000;
/** Deadline of a turn when the runtime gives no remaining time (tests, local flows). */
export const DEFAULT_TURN_BUDGET_MS = 300_000;

export interface WorkerDeps {
  readonly data: Connector;
  readonly turn: Omit<TurnDeps, "data" | "escalation">;
  readonly handlers: EventHandlers;
  readonly escalation: EscalationPort;
  readonly sink: OperationEventSink;
  readonly reader: Pick<ReaderClient, "health">;
  readonly queue: QueueVisibility;
  /** Real time. */
  readonly now: () => Date;
  readonly loggerFor: (correlationId: string) => Logger;
}

export interface LambdaContextLike {
  getRemainingTimeInMillis(): number;
}

export type OperationWorker = (event: SQSEvent, context?: LambdaContextLike) => Promise<void>;

function receiveCountOf(record: SQSRecord): number {
  const count = Number(record.attributes.ApproximateReceiveCount);
  return Number.isInteger(count) && count > 0 ? count : 1;
}

function deadlineOf(deps: WorkerDeps, context: LambdaContextLike | undefined): number {
  const remaining = context === undefined ? DEFAULT_TURN_BUDGET_MS + TURN_TAIL_MARGIN_MS : context.getRemainingTimeInMillis();
  return deps.now().getTime() + Math.max(0, remaining - TURN_TAIL_MARGIN_MS);
}

async function dispatch(deps: WorkerDeps, event: OperationQueueEvent, ctx: WorkerContext, record: SQSRecord, deadlineMs: number): Promise<void> {
  switch (event.type) {
    case "INTAKE_DOCUMENT":
      return deps.handlers.intakeDocument(event, ctx);
    case "AGENT_TURN":
      await runAgentTurn({ ...deps.turn, data: deps.data, escalation: deps.escalation }, event, { ...ctx, deadlineMs });
      return;
    case "TIMER":
      return deps.handlers.fireTimer(event, ctx);
    case "ETA_CHANGED":
      return deps.handlers.rescheduleOnEtaChange(event, ctx);
    case "DISPATCH_STATUS":
      return deps.handlers.notifyDispatchStatus(event, ctx);
    case "EMAIL_EVENT":
      return deps.handlers.applyEmailEvent(event, ctx);
    case "OUTBOUND_SEND":
      return deps.handlers.outboundSend(event, ctx);
    case "ESCALATE":
      return escalateEvent(deps.escalation, event);
    case "HEALTH_PROBE":
      await runHealthProbe({ runtime: deps.data.runtime, reader: deps.reader, now: ctx.now }, event);
      return;
    case "POISON":
      return runPoison(deps.queue, event, record.receiptHandle);
  }
}

async function settle(deps: WorkerDeps, event: OperationQueueEvent): Promise<void> {
  if (isOperationScoped(event)) await deps.data.world.settleInFlight({ operationId: event.operationId, clockId: event.clockId, eventId: event.eventId });
}

/**
 * Last attempt of an event that failed: out of both `inFlight` sets with `processError`, audited, then the
 * caller rethrows. Best effort: a failure here is logged and never hides the event's own error.
 */
async function deadLetter(deps: WorkerDeps, identity: LooseIdentity, log: Logger): Promise<void> {
  const type = OperationEventType.safeParse(identity.type);
  const { eventId, operationId, clockId, firmId, eventAtSim } = identity;
  countMetric(log, DEAD_LETTER_METRIC, { type: type.success ? type.data : "UNKNOWN" });
  if (!type.success || eventId === undefined || operationId === undefined || clockId === undefined) return;
  const atReal = deps.now().toISOString();
  try {
    await deps.data.world.recordProcessError({ operationId, clockId, eventId, type: type.data, atReal });
    if (firmId !== undefined && eventAtSim !== undefined) {
      await auditOnce(deps.data.audit, { action: WORKER_ACTIONS.deadLettered, eventId, firmId, clockId, operationId, atSim: eventAtSim, atReal, detail: { eventId, type: type.data } });
    }
  } catch (error) {
    log.error("event.dead_letter_record_failed", { cause: error instanceof Error ? error.name : "unknown" });
  }
}

async function processRecord(deps: WorkerDeps, record: SQSRecord, context: LambdaContextLike | undefined): Promise<void> {
  const identity = looseIdentity(record.body);
  const receiveCount = receiveCountOf(record);
  const log = deps.loggerFor(correlationIdFrom(identity["correlationId"] ?? identity.eventId)).child({ service: "operation-worker", type: identity.type ?? "UNKNOWN", eventId: identity.eventId, receiveCount });
  const ctx: WorkerContext = { log, sink: deps.sink, now: deps.now, receiveCount };
  try {
    const event = parseQueueEvent(record.body);
    if ((await deps.data.runtime.getIdempotency(event.type, event.eventId)) !== undefined) {
      log.info("event.already_processed");
      await settle(deps, event);
      return;
    }
    await dispatch(deps, event, ctx, record, deadlineOf(deps, context));
    await deps.data.runtime.claimIdempotency({ source: event.type, id: event.eventId, atReal: deps.now().toISOString() });
    await settle(deps, event);
    log.info("event.processed");
  } catch (error) {
    const last = receiveCount >= MAX_RECEIVE_COUNT;
    log.error("event.failed", { cause: error instanceof Error ? error.name : "unknown", lastAttempt: last });
    if (last) await deadLetter(deps, identity, log);
    throw error;
  }
}

/** The SQS handler: batch 1, so a failure fails only its own event. */
export function createOperationWorker(deps: WorkerDeps): OperationWorker {
  return async (event, context) => {
    for (const record of event.Records) await processRecord(deps, record, context);
  };
}
