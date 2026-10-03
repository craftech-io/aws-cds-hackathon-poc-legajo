// The `OperationWorker` of a local world: worker/worker.ts with the same handlers worker/production.ts
// wires in the stage (intake, timers and milestones, ETA, dispatch statuses, SES events, ordered sends),
// the turn over the AgentCore SDK (answered by the scripted Harness through the fake) and G1 over the
// guardrail fake, `escalate_to_broker` through the real `handoff` target, and the guest quotas over the
// in-memory `Runtime`. Only the transport differs: every client is the SDK's, stubbed at `send`.
import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { ApplyGuardrailCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { createHandoffTarget } from "@legajo/bff/agent-tools/handoff/index";
import { handoffImplementations } from "@legajo/bff/agent-tools/handoff/handler";
import { createHarnessClient } from "@legajo/bff/agent/harness-client";
import type { IntakeDocumentEvent } from "@legajo/bff/channels/adapter";
import { dispatchStatusHandler } from "@legajo/bff/feeds/dispatch";
import { escalationsOpener, recordEscalation } from "@legajo/bff/intake/escalation-rules";
import { intakeDocument } from "@legajo/bff/intake/intake";
import type { IntakeDeps } from "@legajo/bff/intake/ports";
import { armedTimerScheduler } from "@legajo/bff/intake/production";
import { readerRetryAction } from "@legajo/bff/intake/retry";
import { s3DocumentStore, s3SourceStore } from "@legajo/bff/intake/storage";
import { timeHandlers } from "@legajo/bff/milestones/handlers";
import { sendOrdered } from "@legajo/bff/outbound/ordered";
import { bounceRetryAction } from "@legajo/bff/services/conversation-control/bounce-retry";
import { deferredSendAction } from "@legajo/bff/services/conversation-control/deferred-send";
import { workerApplyEmailEvent } from "@legajo/bff/services/conversation-control/email-event";
import { createG1Prefilter } from "@legajo/bff/turns/prefilter";
import { handoffEscalation } from "@legajo/bff/worker/escalation";
import type { EventHandlers, WorkerContext } from "@legajo/bff/worker/ports";
import { type OperationWorker, type WorkerDeps, createOperationWorker } from "@legajo/bff/worker/worker";
import { consumeQuota } from "@legajo/bff/worlds/guest-quotas";
import { LOCAL_BUCKETS, MAIL_ROUTES, type StageContext } from "./context";

/** `Resource.Harness` of a local world (the turn's limits are the stage's, infra/agentcore.ts). */
export const LOCAL_HARNESS = { harnessArn: "arn:aws:bedrock-agentcore:us-east-1:000000000000:harness/legajo-local", endpointName: "live", timeoutSeconds: 300, maxIterations: 25 } as const;
/** `Resource.GuardrailG1` of a local world. */
export const LOCAL_G1 = { id: "legajo-local-g1", version: "1" } as const;

const REGION = { region: "us-east-1" } as const;

/** The intake's dependencies for one event, as worker/production.ts builds them. */
function intakeDepsOf(stage: StageContext, ctx: WorkerContext): IntakeDeps {
  const { data, now } = stage;
  const escalations = { data, send: stage.send, wallClock: now, log: ctx.log };
  return {
    connector: data,
    sources: s3SourceStore({ bucketOf: (store) => (store === "UPLOADS" ? LOCAL_BUCKETS.uploads : LOCAL_BUCKETS.media), inbound: () => ({ name: LOCAL_BUCKETS.mail, prefix: MAIL_ROUTES.ops }) }),
    documents: s3DocumentStore({ bucket: () => stage.reader.documentsBucket, sourceUrl: stage.reader.sourceUrl }),
    reader: stage.reader.client,
    escalate: recordEscalation(data, now, escalationsOpener(escalations, ctx.log.correlationId)),
    timers: armedTimerScheduler(stage.timerDeps(ctx.sink)),
    events: ctx.sink,
    wallClock: now,
    log: ctx.log,
    matrixOf: (firmId) => data.firms.getResponsibilityMatrix(firmId),
  };
}

/** The deterministic handlers of every event type but the agent turn (worker/production.ts). */
export function stageEventHandlers(stage: StageContext): EventHandlers {
  const { data, send, services } = stage;
  const applyEmailEvent = workerApplyEmailEvent(services);
  const dispatchStatus = dispatchStatusHandler({ data, send, scheduler: stage.scheduler });
  const time = timeHandlers({
    data,
    scheduler: stage.scheduler,
    dispatcherFor: (sink) => stage.dispatcher(sink),
    send,
    external: (ctx) => ({
      DEFERRED_SEND: deferredSendAction(services),
      READER_RETRY: readerRetryAction(intakeDepsOf(stage, ctx)),
      BOUNCE_RETRY: bounceRetryAction({ data, send, log: ctx.log }),
    }),
  });
  return {
    intakeDocument: async (event: IntakeDocumentEvent, ctx: WorkerContext) => {
      await intakeDocument(intakeDepsOf(stage, ctx), event);
    },
    fireTimer: time.fireTimer,
    rescheduleOnEtaChange: time.rescheduleOnEtaChange,
    milestoneFallback: time.milestoneFallback,
    notifyDispatchStatus: dispatchStatus,
    applyEmailEvent,
    async outboundSend(event, ctx) {
      await sendOrdered(stage.outbound, event, { actor: event.author, correlationId: event.correlationId ?? event.eventId, log: ctx.log, refs: { eventId: event.eventId } });
    },
  };
}

export interface StageWorker {
  readonly deps: WorkerDeps;
  readonly run: OperationWorker;
  /** Receipt handles a `POISON` released (`ChangeMessageVisibility`). */
  readonly released: string[];
}

export function createStageWorker(stage: StageContext): StageWorker {
  const handlers = stageEventHandlers(stage);
  const agentcore = new BedrockAgentCoreClient(REGION);
  const runtime = new BedrockRuntimeClient(REGION);
  const released: string[] = [];
  const deps: WorkerDeps = {
    data: stage.data,
    turn: {
      harness: createHarnessClient({
        link: () => LOCAL_HARNESS,
        send: (input, options) => agentcore.send(new InvokeHarnessCommand(input), { abortSignal: options.abortSignal }),
        nowMs: () => stage.now().getTime(),
        sleep: async () => undefined,
      }),
      prefilter: createG1Prefilter({ link: () => LOCAL_G1, send: (input) => runtime.send(new ApplyGuardrailCommand(input)) }),
      handlers,
      consumeTurnQuota: (clockId, log) => consumeQuota({ client: stage.stores.client, now: stage.now, log }, clockId, "AGENT_TURNS"),
      sessionKey: () => stage.key("session"),
      runtimeSessionKey: () => stage.key("runtime-session"),
      agentMode: "SCRIPTED",
    },
    handlers,
    escalation: handoffEscalation(createHandoffTarget(stage.toolDeps, handoffImplementations({ send: stage.send, agentMode: "SCRIPTED" }))),
    sink: stage.sink,
    reader: stage.reader.client,
    queue: { release: async (handle) => void released.push(handle) },
    now: stage.now,
    loggerFor: () => stage.log,
  };
  return { deps, run: createOperationWorker(deps), released };
}
