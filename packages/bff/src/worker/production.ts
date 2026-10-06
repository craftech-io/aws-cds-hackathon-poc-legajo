// The production dependencies of the `OperationWorker` (docs/architecture.md §7 and §9.1), built once
// per container by handlers/operation-worker.ts from what SST links into the function (lib/resource.ts
// and lib/secrets.ts, never `process.env`):
//
//   data               the DynamoDB connector                         connector/index.ts
//   harness            `InvokeHarness` on the `live` endpoint          Resource.Harness
//   prefilter          G1 `ApplyGuardrail` (`source INPUT`)            Resource.GuardrailG1
//   escalation         `escalate_to_broker` in process, `caller WORKER` agent-tools/handoff
//   sink               `OperationEvents.fifo` (`inFlight` first)       Resource.OperationEvents
//   queue              `ChangeMessageVisibility` of a `POISON`        Resource.OperationEvents
//   reader             `GET /v1/health` and the intake's readings      Resource.ReaderMock
//   consumeTurnQuota   `consumeQuota(clockId, "AGENT_TURNS")`          worlds/guest-quotas.ts
//   keys               `session` and `runtime-session` subkeys         SessionTokenKey
//
// The deterministic handlers of the other modules, imported in process (docs/tool-catalog.md, handlers
// of direct invocation):
//
//   INTAKE_DOCUMENT  intake/intake.ts `intakeDocument`; escalations open through escalations/ (firm email)
//   TIMER            milestones/handlers.ts `timeHandlers` with the actions of the modules that own the
//                    rest: `DEFERRED_SEND` (services/ over outbound/defer.ts), `READER_RETRY`
//                    (intake/retry.ts), `BOUNCE_RETRY` (services/conversation-control/bounce-retry.ts)
//   ETA_CHANGED      milestones/reschedule.ts, and FL-097's fallback of a failed `DOCS_REQUEST` turn
//   DISPATCH_STATUS  feeds/dispatch.ts `dispatchStatusHandler`
//   EMAIL_EVENT      services/conversation-control/email-event.ts `workerApplyEmailEvent`
//   OUTBOUND_SEND    outbound/ordered.ts `sendOrdered` (a `REFUSED` is final: the pipeline audited it)
//
// Every client is built on first use, so a cold start reads no link it does not need.
import type { IntakeDocumentEvent } from "../channels/adapter";
import { connector, tableClient, type Connector } from "../connector/index";
import { createHandoffTarget } from "../agent-tools/handoff/index";
import { createOperationsTarget } from "../agent-tools/operations/index";
import { productionToolDeps } from "../agent-tools/common/deps";
import { linkedHarnessClient } from "../agent/harness-client";
import type { OutboundSender } from "../escalations/ports";
import { dispatchStatusHandler } from "../feeds/dispatch";
import { stageDispatchDeps } from "../feeds/stage";
import { escalationsOpener, recordEscalation } from "../intake/escalation-rules";
import { intakeDocument } from "../intake/intake";
import type { IntakeDeps } from "../intake/ports";
import { armedTimerScheduler, stageIntakePorts } from "../intake/production";
import { readerRetryAction } from "../intake/retry";
import { createLogger, type Logger } from "../lib/log";
import { subkey } from "../lib/secrets";
import { timeHandlers } from "../milestones/handlers";
import type { OutboundDeps } from "../outbound/deps";
import { sendOrdered } from "../outbound/ordered";
import { sendOutbound } from "../outbound/pipeline";
import { stageOutboundDeps } from "../outbound/stage";
import { linkedReaderClient } from "../reader/linked";
import { bounceRetryAction } from "../services/conversation-control/bounce-retry";
import { deferredSendAction } from "../services/conversation-control/deferred-send";
import { workerApplyEmailEvent } from "../services/conversation-control/email-event";
import { stageServiceDeps } from "../services/operations-admin/ports";
import { stageServicePorts } from "../services/operations-admin/stage-ports";
import { eventBridgeScheduler } from "../timers/scheduler-client";
import { stageDispatcher } from "../timers/stage";
import { linkedG1Prefilter } from "../turns/prefilter";
import { consumeQuota } from "../worlds/guest-quotas";
import { handoffEscalation } from "./escalation";
import type { EventHandlers, WorkerContext } from "./ports";
import { linkedQueueVisibility } from "./probe";
import { linkedQueueSink, type OperationEventSink } from "./sink";
import type { WorkerDeps } from "./worker";

/** A value built on its first use and kept for the container. */
function once<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

interface StagePorts {
  readonly data: Connector;
  readonly sink: OperationEventSink;
  readonly now: () => Date;
  readonly outbound: () => OutboundDeps;
  readonly send: OutboundSender;
}

/** The intake's dependencies for one event: the escalation opens through escalations/ (firm email included). */
function intakeDepsOf(ports: StagePorts, ctx: WorkerContext): IntakeDeps {
  const { data, now } = ports;
  const escalations = { data, send: ports.send, wallClock: now, log: ctx.log };
  return {
    connector: data,
    ...stageIntakePorts(),
    escalate: recordEscalation(data, now, escalationsOpener(escalations, ctx.log.correlationId)),
    timers: armedTimerScheduler({ data, scheduler: eventBridgeScheduler(), dispatcher: stageDispatcher(ctx.sink), realClock: now, log: ctx.log }),
    events: ctx.sink,
    wallClock: now,
    log: ctx.log,
    matrixOf: (firmId) => data.firms.getResponsibilityMatrix(firmId),
  };
}

/** The deterministic handlers of every event type but the agent turn, the escalation and the probes. */
export function productionEventHandlers(data: Connector, sink: OperationEventSink, now: () => Date): EventHandlers {
  const log = createLogger({ bindings: { service: "operation-worker" } });
  const outbound = once(() => stageOutboundDeps(log, { data }));
  const ports: StagePorts = { data, sink, now, outbound, send: (request, call) => sendOutbound(outbound(), request, call) };
  const services = once(() => stageServiceDeps(stageServicePorts({ data, events: sink, log, outbound })));
  const applyEmailEvent = once(() => workerApplyEmailEvent(services()));
  const dispatchStatus = once(() => dispatchStatusHandler(stageDispatchDeps(log, data)));
  const time = timeHandlers({
    data,
    scheduler: eventBridgeScheduler(),
    dispatcherFor: stageDispatcher,
    send: ports.send,
    external: (ctx) => ({
      DEFERRED_SEND: (fired) => deferredSendAction(services())(fired),
      READER_RETRY: (fired) => readerRetryAction(intakeDepsOf(ports, ctx))(fired),
      BOUNCE_RETRY: bounceRetryAction({ data, send: ports.send, log: ctx.log }),
    }),
  });

  return {
    intakeDocument: async (event: IntakeDocumentEvent, ctx: WorkerContext) => {
      await intakeDocument(intakeDepsOf(ports, ctx), event);
    },
    fireTimer: time.fireTimer,
    rescheduleOnEtaChange: time.rescheduleOnEtaChange,
    milestoneFallback: time.milestoneFallback,
    notifyDispatchStatus: (event, ctx) => dispatchStatus()(event, ctx),
    applyEmailEvent: (event, ctx) => applyEmailEvent()(event, ctx),
    async outboundSend(event, ctx) {
      const result = await sendOrdered(outbound(), event, { actor: event.author, correlationId: event.correlationId ?? event.eventId, log: ctx.log, refs: { eventId: event.eventId } });
      ctx.log.info("outbound_send.decided", { status: result.status, kind: event.kind });
    },
  };
}

/** Everything the worker runs with in the stage. Nothing is read at import time. */
export function productionWorkerDeps(): WorkerDeps {
  const now = (): Date => new Date();
  const data = connector();
  const sink = linkedQueueSink(data.world);
  const handlers = productionEventHandlers(data, sink, now);
  const client = tableClient();
  return {
    data,
    turn: {
      harness: linkedHarnessClient(() => Date.now()),
      prefilter: linkedG1Prefilter(),
      handlers,
      consumeTurnQuota: (clockId, quotaLog: Logger) => consumeQuota({ client, now, log: quotaLog }, clockId, "AGENT_TURNS"),
      sessionKey: () => subkey("session"),
      runtimeSessionKey: () => subkey("runtime-session"),
      agentMode: "REAL",
      reads: createOperationsTarget(productionToolDeps()),
    },
    handlers,
    escalation: handoffEscalation(createHandoffTarget(productionToolDeps())),
    sink,
    reader: linkedReaderClient(),
    queue: linkedQueueVisibility(),
    now,
    loggerFor: (correlationId) => createLogger({ correlationId, bindings: { service: "operation-worker" } }),
  };
}
