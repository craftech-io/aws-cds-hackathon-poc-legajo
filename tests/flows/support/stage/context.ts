// The stage's own modules, wired over one local world: what each Lambda's `stage*` factory builds from
// its links, built here from the in-memory connector, the AWS fakes (fakes/aws.ts) and the flows'
// master key, and nothing else. Every port is the real module of its owner:
//
//   outbound   the pipeline's ports (outbound/deps.ts): the single SES client with its real fence and
//              the SES fake, the simulated WhatsApp transport, G2 over the guardrail fake, the quotas,
//              the upload links of the real `documents` target, the deferred send's timer
//   timers     timers/ over the Scheduler fake and a dispatcher that enqueues `TIMER` on the in-process
//              FIFO and hands `SIM_REPLY` to SimMail in process (stage/entries.ts)
//   services   the deterministic handlers' dependencies (services/operations-admin/ports.ts) with the
//              same ports `stageServicePorts` gives the worker: `request_approval` through the real
//              `handoff` target, `deferred_send` through `resendDeferred`
//   tools      the five Gateway targets (`createGatewayTargets`) over the same pipeline and timers
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { ToolError, type ErrorCode, type ToolTarget } from "@legajo/shared";
import type { ToolDeps } from "@legajo/bff/agent-tools/common/handler";
import { type GatewayTargets, createGatewayTargets, gatewayTargetsPort } from "@legajo/bff/agent-tools/common/targets";
import { createHandoffTarget } from "@legajo/bff/agent-tools/handoff/index";
import { handoffImplementations } from "@legajo/bff/agent-tools/handoff/handler";
import type { FenceDeps } from "@legajo/bff/channels/email/fence";
import { createEmailClient } from "@legajo/bff/channels/email/outbound";
import { resolveThread } from "@legajo/bff/channels/email/thread";
import { s3MediaStore } from "@legajo/bff/channels/whatsapp/media-store";
import { type SimulatedWhatsAppTransport, simulatedWhatsAppTransport } from "@legajo/bff/channels/whatsapp/simulated-transport";
import type { MediaStore } from "@legajo/bff/channels/whatsapp/transport";
import type { Connector, MemoryStores } from "@legajo/bff/connector/index";
import { timerKeyOf } from "@legajo/bff/domain/timers";
import { firmEsAR } from "@legajo/bff/copy/es-AR-firm";
import { deriveSubkey, emailHash, newPublicToken, phoneHash, ulid, type SubkeyPurpose } from "@legajo/bff/lib/crypto";
import type { Logger } from "@legajo/bff/lib/log";
import { resendDeferred } from "@legajo/bff/outbound/defer";
import type { OutboundDeps } from "@legajo/bff/outbound/deps";
import { createBedrockG2 } from "@legajo/bff/outbound/grounding";
import { sendOutbound } from "@legajo/bff/outbound/pipeline";
import { whatsappRoutes } from "@legajo/bff/outbound/routes";
import type { OutboundSender } from "@legajo/bff/escalations/ports";
import { holidaysReader } from "@legajo/bff/policy-audit/facts";
import type { PlatformOperations } from "@legajo/bff/services/operations-admin/platform";
import type { ServiceDeps } from "@legajo/bff/services/operations-admin/ports";
import type { SimReplyHandoff } from "@legajo/bff/timers/events";
import { type SchedulerPort, eventBridgeScheduler } from "@legajo/bff/timers/scheduler-client";
import { type TimerDeps, type TimerDispatcher, armTimer, timerDispatcher } from "@legajo/bff/timers/timers";
import { type OperationEventSink, createQueueSink } from "@legajo/bff/worker/sink";
import { G2_LIMITS, GROUNDING_FILTERS } from "../../../../infra/guardrail-policies";
import type { AwsFakes } from "../fakes/aws";
import type { InProcessReader } from "../fakes/reader";
import type { ToolTargetsPort } from "../ports";

export const LOCAL_STAGE = "poc";
export const LOCAL_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/legajo-local-operation-events.fifo";
/** Buckets of the local world, named after the stage's logical buckets. */
export const LOCAL_BUCKETS = { media: "legajo-local-media", uploads: "legajo-local-uploads", mail: "legajo-local-mail", quarantine: "legajo-local-quarantine" } as const;
/** Prefixes the receipt rules write under (`ops-poc`, `sim-poc`). */
export const MAIL_ROUTES = { ops: `${LOCAL_STAGE}/ops/`, sim: `${LOCAL_STAGE}/sim/` } as const;

const REGION = { region: "us-east-1" } as const;

function threshold(type: "GROUNDING" | "RELEVANCE"): number {
  const filter = GROUNDING_FILTERS.find((candidate) => candidate.type === type);
  if (filter === undefined) throw new Error(`no ${type} filter in infra/guardrail-policies.ts`);
  return filter.threshold;
}

/** `Resource.GuardrailG2` of a local world: the stage's thresholds and limits (infra/guardrail.ts). */
export const LOCAL_G2 = { id: "legajo-local-g2", version: "1", groundingThreshold: threshold("GROUNDING"), relevanceThreshold: threshold("RELEVANCE"), ...G2_LIMITS } as const;

/** The stage's Scheduler client (timers/scheduler-client.ts) over the Scheduler fake. */
export function localScheduler(): SchedulerPort {
  return eventBridgeScheduler({
    link: () => ({ groupName: "legajo-local-timers", roleArn: "arn:aws:iam::000000000000:role/legajo-local-scheduler", targetArn: "arn:aws:lambda:us-east-1:000000000000:function:legajo-local-schedule-dispatch" }),
    client: new SchedulerClient(REGION),
    sleep: async () => undefined,
  });
}

/**
 * ULIDs that grow within one millisecond: real time stands still in a local world, and the policy breaks
 * ties between two sends of the same instant by message id (policy/frequency.ts `isBefore`).
 */
export function monotonicIds(now: () => Date): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const value = counter;
    return ulid(now().getTime(), (size) => Uint8Array.from({ length: size }, (_, index) => (index === size - 1 ? value & 0xff : index === size - 2 ? (value >> 8) & 0xff : 0)));
  };
}

export interface StageBase {
  readonly stores: MemoryStores;
  readonly data: Connector;
  readonly aws: AwsFakes;
  readonly reader: InProcessReader;
  readonly master: Uint8Array;
  readonly now: () => Date;
  readonly log: Logger;
  /** `SimMail` in process: what `ScheduleDispatch` hands a due `SIM_REPLY` to. */
  readonly simReply: (handoff: SimReplyHandoff) => Promise<void>;
  /** `GET` of the platform's master data (`create_operation`). */
  readonly platform: Pick<PlatformOperations, "get">;
}

export interface StageContext extends StageBase {
  key(purpose: SubkeyPurpose): Uint8Array;
  readonly sink: OperationEventSink;
  readonly scheduler: SchedulerPort;
  dispatcher(sink?: OperationEventSink): TimerDispatcher;
  timerDeps(sink?: OperationEventSink): TimerDeps & { readonly data: Connector };
  readonly media: MediaStore;
  readonly transport: SimulatedWhatsAppTransport;
  readonly fence: FenceDeps;
  readonly outbound: OutboundDeps;
  readonly send: OutboundSender;
  readonly toolDeps: ToolDeps;
  readonly targets: GatewayTargets;
  readonly services: ServiceDeps;
}

function uploadLinksOf(targets: () => GatewayTargets): OutboundDeps["uploadLinks"] {
  return {
    async issue(input) {
      const answer = await targets().documents.invoke("create_upload_link", { caller: { kind: "WORKER", firmId: input.firmId }, operationId: input.operationId, docTypes: [...input.docTypes] });
      if (!answer.ok) throw new ToolError(answer.error.code as ErrorCode, `the upload link could not be created: ${answer.error.message}`, answer.error.reason);
      const { token, url } = answer as { token?: unknown; url?: unknown };
      if (typeof token !== "string" || typeof url !== "string") throw new ToolError("UNAVAILABLE", "create_upload_link answered without a link");
      return { token, url };
    },
  };
}

export function createStageContext(base: StageBase): StageContext {
  const { data, stores, now, log } = base;
  const key = (purpose: SubkeyPurpose) => deriveSubkey(base.master, purpose);
  const sink = createQueueSink({ world: data.world, send: async (input) => base.aws.queue.send(input), queueUrl: () => LOCAL_QUEUE_URL, sleep: async () => undefined });
  const scheduler = localScheduler();
  const dispatcher = (events: OperationEventSink = sink) => timerDispatcher({ events, simReply: base.simReply });
  const timerDeps = (events: OperationEventSink = sink) => ({ data, scheduler, dispatcher: dispatcher(events), realClock: now, log });
  const media = s3MediaStore({ bucket: LOCAL_BUCKETS.media });
  const transport = simulatedWhatsAppTransport({ conversations: data.conversations, templates: data.reference, media, realClock: { now: async () => now() }, log });
  const fence: FenceDeps = {
    resolveThread: (address) => resolveThread({ operations: data.operations, world: data.world, threadKey: key("thread"), now }, address),
    parties: data.parties,
    emailHash: (address) => emailHash(key("email-hash"), address),
    demoRecipients: () => [],
  };
  const newId = monotonicIds(now);
  let targets: GatewayTargets | undefined;
  const outbound: OutboundDeps = {
    data,
    email: createEmailClient({ fence, world: data.world, runtime: data.runtime, audit: data.audit, configurationSet: (profile) => `legajo-local-${profile.toLowerCase()}`, stage: LOCAL_STAGE, now, newMailId: newId, log, ses: new SESv2Client(REGION) }),
    whatsapp: whatsappRoutes({ mode: () => "simulated", simulated: () => transport, live: () => {
        throw new ToolError("UNAVAILABLE", "the local flows have no live WhatsApp");
      } }),
    guardrail: createBedrockG2({ client: new BedrockRuntimeClient(REGION), config: () => LOCAL_G2, sleep: async () => undefined }),
    g2Limits: () => LOCAL_G2,
    fence,
    quotaTable: stores.client,
    nonceKey: () => key("nonce"),
    emailHash: (address) => emailHash(key("email-hash"), address),
    uploadLinks: uploadLinksOf(() => targets as GatewayTargets),
    arming: {
      async arm(spec) {
        const armed = await armTimer({ operationId: spec.operationId, clockId: spec.clockId, kind: "DEFERRED_SEND", timerId: spec.timerId, dueAtSim: spec.dueAtSim, reason: spec.reason, payload: spec.payload }, timerDeps());
        return { timerKey: timerKeyOf(armed.timer.kind, armed.timer.timerId) };
      },
    },
    holidays: holidaysReader(data),
    wallClock: now,
    newId,
  };
  const send: OutboundSender = (request, call) => sendOutbound(outbound, request, call);
  const toolDeps: ToolDeps = { connector: data, sessionKey: () => key("session"), wallClock: now, loggerFor: () => log };
  const handoff = createHandoffTarget(toolDeps, handoffImplementations({ send, agentMode: "SCRIPTED" }));
  targets = createGatewayTargets(toolDeps, {
    messaging: { outbound: () => outbound },
    handoff: { send, agentMode: "SCRIPTED" },
    followups: { scheduler, dispatcher: dispatcher() },
    documents: { reader: () => base.reader.client, sourceUrl: base.reader.sourceUrl, newToken: () => newPublicToken() },
  });
  const services: ServiceDeps = {
    connector: data,
    wallClock: now,
    loggerFor: () => log,
    events: sink,
    timers: timerDeps(),
    approvals: {
      async requestApproval(request) {
        const answer = await handoff.invoke("request_approval", { caller: { kind: "WORKER", firmId: request.firmId, eventId: request.eventId }, operationId: request.operationId, summary: firmEsAR.completedByFirm });
        if (!answer.ok) throw new ToolError(answer.error.code, `request_approval answered ${answer.error.code}`, answer.error.reason);
      },
    },
    deferred: {
      async resend(request) {
        const decided = await resendDeferred(
          outbound,
          { actor: "SYSTEM", correlationId: request.correlationId ?? request.messageId, log, refs: { operationId: request.operationId, messageId: request.messageId } },
          { operationId: request.operationId, messageId: request.messageId, timerKey: request.timerKey, atSim: request.atSim },
        );
        return { status: decided.status, ...(decided.nextAllowedAt === undefined ? {} : { nextAllowedAt: decided.nextAllowedAt }) };
      },
    },
    keys: { phoneHash: (phone) => phoneHash(key("phone-hash"), phone), emailHash: (email) => emailHash(key("email-hash"), email), threadKey: () => key("thread") },
    demoRecipients: () => [],
    quotaTable: stores.client,
    platform: base.platform,
    newId,
  };
  return { ...base, key, sink, scheduler, dispatcher, timerDeps, media, transport, fence, outbound, send, toolDeps, targets, services };
}

/** The Gateway's targets as the local Gateway calls them (gateway.ts: Cedar first, then this). */
export function stageTargets(stage: Pick<StageContext, "targets">): ToolTargetsPort {
  const port = gatewayTargetsPort(stage.targets);
  return { invoke: (call) => port.invoke({ target: call.target as ToolTarget, action: call.action, input: call.input }) };
}
