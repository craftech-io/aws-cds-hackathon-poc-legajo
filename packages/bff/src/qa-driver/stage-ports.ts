// The ports of the `QaDriver` in the stage (ports.ts), each over the module that owns it and the links
// of infra/bff.ts (`Resource`, never `process.env`). Every client is built on first use:
//
//   worlds    world factory (worlds-port.ts): objects only under `QaWorldObjects`, Memory passes 2+ to
//             `WorldJanitor MEMORY_PURGE`
//   clock     clock/advance.ts and clock/modes.ts with the stage's Scheduler and dispatcher (timers/stage.ts),
//             caller `QA` (no `WORLD_BUSY` gate: the driver waits with `op.settle`)
//   channels  stage-channels.ts: `InboundWhatsApp`, the SES client's `QA` profile, `InboundEmail`
//   simMail   `SimMail` `sim_reply` with `mode: SEND_NOW`, synchronously
//   worker    `POISON`, `HEALTH_PROBE` and stale `TIMER` events through the queue producer (worker/sink.ts),
//             and the forced turn failure the worker consumes (turns/forced-failure.ts)
//   fence     outbound/recipient-fence.ts `probeFence`: the SES client's fence and the registry, no send
//   batch     batch.ts over the factory, the clock and the seed's entries
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ToolError, seedKeys } from "@legajo/shared";
import type { ClockDeps } from "../clock/advance";
import { advanceClock, fireMilestoneNow } from "../clock/advance";
import { freeze, unfreeze } from "../clock/modes";
import { stageEmailClient, stageFenceDeps } from "../channels/email/adapter";
import { stagePhoneSimulator } from "../channels/whatsapp/adapter";
import type { Connector } from "../connector/index";
import { simNowOf } from "../lib/clock";
import { awsClientConfig } from "../lib/clients";
import { type Logger, createLogger } from "../lib/log";
import { bucketName, channelMode } from "../lib/resource";
import { probeFence } from "../outbound/recipient-fence";
import { STAGE_REGION } from "../public-web/presign";
import { s3SimulatorMedia } from "../routers/console-services";
import { lambdaSimMailInvoker } from "../sim-mail/invoke";
import { s3SeedPdfStore } from "../sim-mail/seed-pdfs";
import { lambdaAsyncInvoker } from "../signup/invoke";
import { eventBridgeScheduler } from "../timers/scheduler-client";
import { timerEventId } from "../timers/events";
import { stageDispatcher } from "../timers/stage";
import { requestForcedFailure } from "../turns/forced-failure";
import { type OperationEventSink, linkedQueueSink } from "../worker/sink";
import { type WorldsDeps, stageWorldsDeps } from "../worlds/deps";
import { qaWorldObjectsGrant, s3WorldObjects } from "../worlds/objects";
import { batchPort, parseJsonl } from "./batch";
import { qaEventId } from "./contract";
import type { ActionContext, ClockPort, QaPorts, SimMailPort, WorkerPort } from "./ports";
import { stageChannels, lambdaInboundEmail } from "./stage-channels";
import { worldFactoryPort } from "./worlds-port";

function lazy<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

/** `supplier.sendNow` over `SimMail`: a refusal is the step's error. */
function simMailPort(): SimMailPort {
  const simMail = lambdaSimMailInvoker();
  return {
    async sendNow(input) {
      const result = await simMail.sendNow({ ...input, docTypes: [...input.docTypes] });
      if (result.status === "REFUSED") throw new ToolError(result.code, `SimMail refused the send: ${result.reason}`, result.reason);
    },
  };
}

/** The world factory with the stage's links: objects only under `QaWorldObjects`, no raw MIME. */
function stageQaWorlds(log: Logger): () => WorldsDeps {
  return lazy(() => {
    const invoker = lambdaAsyncInvoker();
    const base = stageWorldsDeps({ log, continuePurge: (target) => invoker.invoke("WorldJanitor", { ...target, kind: "MEMORY_PURGE" }) });
    return { ...base, objects: s3WorldObjects({ grant: qaWorldObjectsGrant }), mailPrefixes: () => [] };
  });
}

const caller = (ctx: ActionContext) => ({ actor: "QA" as const, correlationId: ctx.log.correlationId });

export function clockPort(deps: () => ClockDeps & { readonly data: Connector }): ClockPort {
  return {
    advance: (clockId, target, ctx) => advanceClock({ clockId, target, caller: caller(ctx) }, deps()),
    fireMilestone: (operationId, milestone, ctx) => fireMilestoneNow({ operationId, milestone, caller: caller(ctx) }, deps()),
    unfreeze: (clockId, leadSec) => unfreeze({ clockId, leadSec }, deps()),
    freeze: (clockId) => freeze({ clockId }, deps()),
  };
}

export function workerPort(data: Connector, sink: () => OperationEventSink): WorkerPort {
  async function simNow(clockId: string, ctx: ActionContext): Promise<string> {
    return simNowOf(await data.world.getClock(clockId), ctx.now().getTime()).toISOString();
  }
  return {
    async poison(input, ctx) {
      const operation = await data.operations.getOperation(input.operationId);
      await sink().enqueue({ type: "POISON", eventId: input.eventId, operationId: operation.operationId, clockId: input.clockId, firmId: operation.firmId, eventAtSim: await simNow(input.clockId, ctx), correlationId: ctx.log.correlationId });
    },
    forceNextTurnFailure: (input, ctx) => requestForcedFailure(data.runtime, { operationId: input.operationId, clockId: input.clockId, atReal: ctx.now().toISOString() }),
    async healthProbe(input, ctx) {
      await sink().enqueue({ type: "HEALTH_PROBE", eventId: await qaEventId(ctx.idempotencyKey), probeId: input.probeId, correlationId: ctx.log.correlationId });
    },
    async fireStale(input, ctx) {
      const operation = await data.operations.getOperation(input.operationId);
      const timer = await data.timers.getTimer(input.operationId, input.timerKey);
      if (input.version >= timer.version) throw new ToolError("INVALID", `version ${input.version} is not older than the timer's ${timer.version}`, "NOT_STALE");
      await sink().enqueue({
        type: "TIMER",
        eventId: timerEventId(input.operationId, input.timerKey, timer.dueAtSim, input.version, timer.worldEpoch),
        operationId: input.operationId,
        clockId: input.clockId,
        firmId: operation.firmId,
        eventAtSim: timer.dueAtSim,
        timerKey: input.timerKey,
        dueAtSim: timer.dueAtSim,
        version: input.version,
        firedBy: "SCHEDULER",
        correlationId: ctx.log.correlationId,
      });
    },
  };
}

const SEED_TIMEOUTS = { requestTimeoutMs: 10_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;

/** `Seed/metrics/batch-inputs.jsonl`, read once per container. */
function seedBatchInputs(): () => Promise<readonly unknown[]> {
  let rows: Promise<readonly unknown[]> | undefined;
  const s3 = lazy(() => new S3Client({ region: STAGE_REGION, ...awsClientConfig(SEED_TIMEOUTS) }));
  return () =>
    (rows ??= (async () => {
      const object = await s3().send(new GetObjectCommand({ Bucket: bucketName("Seed"), Key: seedKeys.batchInputs }));
      return parseJsonl((await object.Body?.transformToString("utf-8")) ?? "");
    })());
}

/** Every port of the stage's driver. */
export function stagePorts(data: Connector): QaPorts {
  const log = createLogger({ bindings: { service: "qa-driver-ports" } });
  const sink = lazy(() => linkedQueueSink(data.world));
  const worlds = stageQaWorlds(log);
  const clockDeps = lazy(() => ({ data, scheduler: eventBridgeScheduler(), dispatcher: stageDispatcher(sink()), realClock: () => new Date(), log }));
  const email = lazy(() => stageEmailClient(log, data));
  const seedPdfs = lazy(() => s3SeedPdfStore());
  return {
    worlds: worldFactoryPort(worlds),
    clock: clockPort(clockDeps),
    channels: stageChannels({
      data,
      log,
      phone: lazy(stagePhoneSimulator),
      media: s3SimulatorMedia({ media: () => bucketName("Media"), seed: () => bucketName("Seed") }),
      seedPdfs,
      email,
      inboundEmail: lambdaInboundEmail(),
    }),
    simMail: simMailPort(),
    worker: workerPort(data, sink),
    fence: { probe: (input) => probeFence({ fence: stageFenceDeps(data), data }, input) },
    batch: batchPort({ data, worlds, clock: clockDeps, inputs: seedBatchInputs(), whatsappSimulated: () => channelMode("whatsapp") === "simulated" }),
  };
}
