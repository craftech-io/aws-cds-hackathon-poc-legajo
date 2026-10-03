// One handler per `QaDriver` action (docs/tool-catalog.md), over the adapters the Lambda entry wires
// (handlers/qa-driver.ts) or the fakes of the tests. What reads stored state is actions-state.ts; what
// drives a module the driver does not own goes through its port (actions-ports.ts, ports.ts).
import { ToolError } from "@legajo/shared";
import type { FaultConfigInput } from "@legajo/reader-mock/catalog";
import type { TableClient } from "../connector/index";
import type { Operation } from "../domain/operations";
import { simNowOf } from "../lib/clock";
import { expireActions, lastUploadToken, mailOutcomeAction, policyAuditAction, setBehaviourAction, settleAction, snapshotAction, usageOfWorld } from "./actions-state";
import { portActions } from "./actions-ports";
import { QA_REASON } from "./contract";
import type { AlarmTransition, DlqPort } from "./aws-queue";
import type { PlatformClient } from "./aws-mocks";
import { type QaConsoleDeps, callConsole } from "./console";
import type { QaParsedInput } from "./contract-inputs";
import { type MemoryReader, type MemoryTarget, inspectMemory, waitForExtraction } from "./memory-inspect";
import type { ActionContext, ActionHandlers, QaPorts } from "./ports";
import { type SignupActionDeps, signupActions } from "./signup-actions";
import type { BrowserUpload } from "./upload";

/** Actor and current session of an operation in AgentCore Memory (docs/architecture.md §9.1). */
export interface MemoryIdentity {
  of(operation: Operation): { readonly actorId: string; readonly sessionId: string };
}

export interface HandlerDeps {
  readonly table: TableClient;
  readonly ports: QaPorts;
  readonly platform: Pick<PlatformClient, "get" | "moveEta" | "customsStatus">;
  readonly mocksHealth: () => Promise<Record<string, "ok" | "unavailable">>;
  readonly readerFaults: (clockId: string, config: FaultConfigInput, now: Date) => Promise<unknown>;
  readonly dlq: DlqPort;
  readonly alarmHistory: (since: string) => Promise<AlarmTransition[]>;
  readonly guardrailProbe: (text?: string) => Promise<{ readonly action: string }>;
  readonly memory: MemoryReader;
  readonly memoryIdentity: MemoryIdentity;
  readonly upload: BrowserUpload;
  /** Download links and WhatsApp mode of the console calls. */
  readonly console: Omit<QaConsoleDeps, "data" | "now">;
  /** SC-26's ports (mail bucket, `Leads`, the pool), built on first use. */
  readonly signup: () => SignupActionDeps;
}

/** How long `probe.mocks` waits for the worker's `PROBE#<id>` of its `HEALTH_PROBE`. */
export const WORKER_PROBE_WAIT_MS = 60_000;

async function worldSimNow(ctx: ActionContext, clockId: string): Promise<string> {
  return simNowOf(await ctx.data.world.getClock(clockId), ctx.now().getTime()).toISOString();
}

async function workerProbe(deps: HandlerDeps, ctx: ActionContext): Promise<"ok" | "unavailable"> {
  const probeId = `qa-health-${ctx.idempotencyKey.replaceAll("/", "-")}`;
  await deps.ports.worker.healthProbe({ probeId }, ctx);
  const deadline = ctx.now().getTime() + WORKER_PROBE_WAIT_MS;
  while (ctx.now().getTime() < deadline) {
    const probe = await ctx.data.runtime.getProbe(probeId);
    if (probe !== undefined) return probe.ok ? "ok" : "unavailable";
    await ctx.sleep(2_000);
  }
  return "unavailable";
}

/** Source of the instant a platform event was first published under its key (`feed.eta`, `feed.customs`). */
export const FEED_INSTANT_SOURCE = "QAFEED";

/**
 * `occurredAtSim` of a platform event: the world's now the first time its `Idempotency-Key` is used, the
 * same instant on every replay of that key, so the mock sees the same body and publishes the same event.
 */
async function feedInstant(ctx: ActionContext, platformKey: string, clockId: string): Promise<string> {
  const stored = (await ctx.data.runtime.getIdempotency(FEED_INSTANT_SOURCE, platformKey))?.result?.occurredAtSim;
  if (typeof stored === "string") return stored;
  const occurredAtSim = await worldSimNow(ctx, clockId);
  await ctx.data.runtime.claimIdempotency({ source: FEED_INSTANT_SOURCE, id: platformKey, atReal: ctx.now().toISOString(), result: { occurredAtSim } });
  return ((await ctx.data.runtime.getIdempotency(FEED_INSTANT_SOURCE, platformKey))?.result?.occurredAtSim as string | undefined) ?? occurredAtSim;
}

/** `platform.get` reads only an operation number of the fenced world (never another world's row of the firm). */
async function assertNumberOfWorld(ctx: ActionContext, operationNumber: string): Promise<void> {
  const operations = await ctx.data.operations.listOperations(ctx.scope.firmId, { clockId: ctx.scope.clockId ?? "" });
  if (!operations.some((operation) => operation.operationNumber === operationNumber)) throw new ToolError("FORBIDDEN", `${operationNumber} is not an operation of ${ctx.scope.clockId ?? "the world"}`, QA_REASON.QA_FENCE);
}

async function memoryTarget(deps: HandlerDeps, input: QaParsedInput<"memory.inspect">, ctx: ActionContext): Promise<MemoryTarget> {
  if (input.operationId !== undefined) {
    const identity = deps.memoryIdentity.of(await ctx.data.operations.getOperation(input.operationId));
    return { actorId: identity.actorId, sessionIds: [identity.sessionId, ...input.sessionIds] };
  }
  if (input.actorId === undefined || !input.actorId.startsWith("imp-")) throw new ToolError("INVALID", "an actor of a QA world starts with imp-");
  return { actorId: input.actorId, sessionIds: input.sessionIds };
}

export function buildHandlers(deps: HandlerDeps): ActionHandlers {
  const ports = portActions(deps.ports);
  const expire = expireActions(deps.table);
  const consoleOf = (ctx: ActionContext): QaConsoleDeps => ({ ...deps.console, data: ctx.data, now: ctx.now });
  return {
    "world.create": ports.worldCreate,
    "world.destroy": ports.worldDestroy,
    "clock.advance": ports.advance,
    "clock.advanceTo": ports.advanceTo,
    "clock.advanceToNext": ports.advanceToNext,
    "clock.fireMilestone": ports.fireMilestone,
    "clock.unfreeze": ports.unfreeze,
    "clock.freeze": ports.freeze,
    "op.settle": settleAction,
    snapshot: snapshotAction,
    "wa.inbound": ports.waInbound,
    async "upload.presign"(input, ctx) {
      const operation = await ctx.data.operations.getOperation(input.operationId);
      return deps.upload.presign(await lastUploadToken(ctx, input.operationId), input.file, operation.templateOperation);
    },
    async "upload.done"(input, ctx) {
      return deps.upload.done(await lastUploadToken(ctx, input.operationId), input.keys);
    },
    "supplier.setBehaviour": setBehaviourAction,
    "supplier.sendNow": ports.sendNow,
    "reader.setFaults": (input, ctx) =>
      deps.readerFaults(input.clockId, { mode: input.mode, rate: input.rate, until: new Date(ctx.now().getTime() + input.minutes * 60_000).toISOString() }, ctx.now()),
    async "feed.eta"(input, ctx) {
      const operation = await ctx.data.operations.getOperation(input.operationId);
      const platformKey = input.platformKey ?? ctx.idempotencyKey;
      const answer = await deps.platform.moveEta({ firmId: operation.firmId, operationNumber: operation.operationNumber, newEta: input.newEta, occurredAtSim: await feedInstant(ctx, platformKey, operation.clockId), idempotencyKey: platformKey });
      return { eventId: answer.event.detail.eventId, replayed: answer.replayed };
    },
    async "feed.customs"(input, ctx) {
      const operation = await ctx.data.operations.getOperation(input.operationId);
      const platformKey = input.platformKey ?? ctx.idempotencyKey;
      const answer = await deps.platform.customsStatus({
        firmId: operation.firmId,
        operationNumber: operation.operationNumber,
        status: input.status,
        ...(input.channel === undefined ? {} : { channel: input.channel }),
        occurredAtSim: await feedInstant(ctx, platformKey, operation.clockId),
        idempotencyKey: platformKey,
      });
      return { eventId: answer.event.detail.eventId, replayed: answer.replayed };
    },
    console: (input, ctx) => callConsole(consoleOf(ctx), input, ctx.log.correlationId),
    "email.inject": ports.emailInject,
    "mail.outcome": mailOutcomeAction,
    "email.redeliver": ports.redeliver,
    "link.expire": expire.linkExpire,
    "nonce.expire": expire.nonceExpire,
    "schedule.fireStale": ports.fireStale,
    "fence.probe": ports.fenceProbe,
    "guardrail.probe": (input) => deps.guardrailProbe(input.text),
    "turn.forceFailure": ports.forceFailure,
    "event.poison": ports.poison,
    "dlq.find": (input) => deps.dlq.find(input),
    "dlq.delete": (input) => deps.dlq.remove(input),
    "alarm.history": async (input) => ({ transitions: await deps.alarmHistory(input.since) }),
    async "platform.get"(input, ctx) {
      await assertNumberOfWorld(ctx, input.operationNumber);
      return deps.platform.get(input.firmId, input.operationNumber);
    },
    async "probe.mocks"(_input, ctx) {
      return { ...(await deps.mocksHealth()), worker: await workerProbe(deps, ctx) };
    },
    async "memory.inspect"(input, ctx) {
      const target = await memoryTarget(deps, input, ctx);
      if (input.waitForExtraction === undefined) return inspectMemory(deps.memory, target);
      return waitForExtraction({ reader: deps.memory, now: ctx.now, sleep: ctx.sleep }, target, input.waitForExtraction);
    },
    "policyAudit.run": policyAuditAction,
    async "metrics.get"(input, ctx) {
      const summary = await callConsole(consoleOf(ctx), { procedure: "metrics.summary", input: { clockId: input.clockId, tab: "WORLD" }, role: "BROKER", authTimeAgoSec: 0 }, ctx.log.correlationId);
      const operations = await ctx.data.operations.listOperations(ctx.scope.firmId, { clockId: input.clockId });
      return {
        usage: await usageOfWorld(ctx, input.clockId),
        summary,
        operations: operations.map((operation) => ({ operationId: operation.operationId, operationNumber: operation.operationNumber, importerId: operation.importerId, dossierStatus: operation.dossierStatus })),
      };
    },
    "batch.run": ports.batch,
    ...signupActions(deps.signup),
  };
}
