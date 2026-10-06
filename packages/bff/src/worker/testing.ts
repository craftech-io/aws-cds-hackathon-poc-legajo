// Test kit of the `OperationWorker` and its turns: the console's world over the in-memory connector
// (routers/testing.ts: firm `firm-delta` with operation 4471, and the guest firm when asked), the real
// queue sink over a recording `SendMessage`, a scripted Harness and a scripted G1, escalations opened
// through the connector, recorded handlers of the other modules and a logger whose metric lines can be
// read back. Real time is fixed unless a test moves it.
import { createOperationsTarget } from "../agent-tools/operations/index";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import type { TurnTrigger } from "@legajo/shared";
import type { HarnessClient, HarnessTurnRequest, HarnessTurnResult } from "../agent/harness-client";
import { turnEventId } from "../channels/adapter";
import type { MemoryStores } from "../connector/index";
import { CLOCK, FIRM, REAL_NOW, START_SIM, hashOf, memoryStores, operationFixture } from "../connector/testing";
import type { TokenUsage } from "../domain/conversations";
import { deriveSubkey } from "../lib/crypto";
import { createLogger, type Logger } from "../lib/log";
import { GUEST_FIRM, seedConsoleWorld } from "../routers/testing";
import type { G1Prefilter, G1Verdict } from "../turns/prefilter";
import { consumeQuota } from "../worlds/guest-quotas";
import type { OperationQueueEventInput, TurnEvent } from "./events";
import type { EscalationPort, EscalationRequest, EventHandlers, MilestoneFallbackInput } from "./ports";
import type { QueueVisibility } from "./probe";
import { createQueueSink, type OperationEventSink } from "./sink";
import { type WorkerDeps, createOperationWorker } from "./worker";

export { CLOCK, FIRM, GUEST_FIRM, REAL_NOW, START_SIM };
export const OPERATION = "op-4471";
export const GUEST_CLOCK = `GUEST#${GUEST_FIRM}`;
export const GUEST_OPERATION = "op-7001";
const MASTER_KEY = new TextEncoder().encode("legajo-worker-tests-master-key-01");

export const USAGE: TokenUsage = { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0 };

export function completed(overrides: Partial<HarnessTurnResult> = {}): HarnessTurnResult {
  return { outcome: "COMPLETED", stopReason: "end_turn", note: "Pedí el packing list al proveedor.", usage: USAGE, toolUses: 1, attempts: 1, ...overrides };
}

export interface ScriptedHarness extends HarnessClient {
  readonly requests: HarnessTurnRequest[];
}

/** Answers each invocation with the next result, or throws it when it is an error. */
export function scriptedHarness(results: ReadonlyArray<HarnessTurnResult | Error> = []): ScriptedHarness {
  const queue = [...results];
  const requests: HarnessTurnRequest[] = [];
  return {
    requests,
    async invoke(request) {
      requests.push(request);
      const next = queue.shift() ?? completed();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

export interface ScriptedPrefilter extends G1Prefilter {
  readonly texts: string[];
}

export function scriptedPrefilter(verdicts: readonly G1Verdict[] = []): ScriptedPrefilter {
  const queue = [...verdicts];
  const texts: string[] = [];
  return {
    texts,
    async check(text) {
      texts.push(text);
      return queue.shift() ?? { action: "NONE" };
    },
  };
}

export interface RecordedHandlers extends EventHandlers {
  readonly calls: Array<{ readonly handler: keyof EventHandlers; readonly input: unknown }>;
}

/** The other modules' handlers, recording what the worker hands them; `fail` makes one throw. */
export function recordedHandlers(fail: Partial<Record<keyof EventHandlers, Error>> = {}): RecordedHandlers {
  const calls: RecordedHandlers["calls"] = [];
  const record =
    (handler: keyof EventHandlers) =>
    async (input: unknown): Promise<void> => {
      calls.push({ handler, input });
      const error = fail[handler];
      if (error !== undefined) throw error;
    };
  return {
    calls,
    intakeDocument: record("intakeDocument"),
    fireTimer: record("fireTimer"),
    rescheduleOnEtaChange: record("rescheduleOnEtaChange"),
    notifyDispatchStatus: record("notifyDispatchStatus"),
    applyEmailEvent: record("applyEmailEvent"),
    outboundSend: record("outboundSend"),
    milestoneFallback: (input: MilestoneFallbackInput) => record("milestoneFallback")(input),
  };
}

export interface WorkerWorld {
  readonly stores: MemoryStores;
  readonly harness: ScriptedHarness;
  readonly prefilter: ScriptedPrefilter;
  readonly handlers: RecordedHandlers;
  readonly escalations: EscalationRequest[];
  readonly sent: SendMessageCommandInput[];
  readonly released: string[];
  readonly lines: string[];
  readonly deps: WorkerDeps;
  readonly sink: OperationEventSink;
  readonly log: Logger;
  advanceReal(ms: number): void;
  realNow(): Date;
  /** Runs one delivery of `event` (receive count 1 by default). */
  deliver(event: OperationQueueEventInput, receiveCount?: number): Promise<void>;
  /** Metric lines written so far (`metric <name>`). */
  metrics(name: string): Array<Record<string, unknown>>;
}

export interface WorkerWorldOptions {
  readonly harness?: ReadonlyArray<HarnessTurnResult | Error>;
  readonly verdicts?: readonly G1Verdict[];
  readonly fail?: Partial<Record<keyof EventHandlers, Error>>;
  readonly guestWorld?: boolean;
  readonly readerOk?: boolean;
  /** Runs the operations target in process before the Harness, as the stage does (turns/preload.ts). */
  readonly reads?: boolean;
}

function escalationPort(stores: MemoryStores, requests: EscalationRequest[]): EscalationPort {
  return {
    async escalate(request) {
      requests.push(request);
      const operation = await stores.connector.operations.getOperation(request.operationId);
      const { escalation } = await stores.connector.operations.openEscalation({
        operationId: request.operationId,
        firmId: request.firmId,
        clockId: operation.clockId,
        reason: request.reason,
        summary: request.summary,
        openedAtSim: START_SIM,
        openedBy: "SYSTEM",
      });
      return { escalationId: escalation.escalationId };
    },
  };
}

/** An operation of a guest world (`GUEST#<firmId>`), so the quota of its turns applies. */
export async function seedGuestOperation(stores: MemoryStores, firmId: string = GUEST_FIRM, operationNumber = "7001"): Promise<string> {
  const operation = operationFixture({ operationNumber, threadTag: "g7q2m4", firmId, clockId: `GUEST#${firmId}` });
  await stores.connector.operations.createOperation({ ...operation, threadClaimHash: hashOf(`${firmId}#${operationNumber}`) });
  return operation.operationId;
}

export async function workerWorld(options: WorkerWorldOptions = {}): Promise<WorkerWorld> {
  let realMs = Date.parse(REAL_NOW);
  const now = (): Date => new Date(realMs);
  const stores = memoryStores();
  await seedConsoleWorld(stores, { guestWorld: options.guestWorld ?? false });
  if (options.guestWorld) await seedGuestOperation(stores);
  const lines: string[] = [];
  const log = createLogger({ sink: (line) => lines.push(line), now, level: "debug" });
  const harness = scriptedHarness(options.harness);
  const prefilter = scriptedPrefilter(options.verdicts);
  const handlers = recordedHandlers(options.fail);
  const escalations: EscalationRequest[] = [];
  const sent: SendMessageCommandInput[] = [];
  const released: string[] = [];
  const sink = createQueueSink({ world: stores.connector.world, send: async (input) => sent.push(input), queueUrl: () => "https://sqs.us-east-1.amazonaws.com/000000000000/operation-events.fifo", sleep: async () => undefined });
  const queue: QueueVisibility = { release: async (handle) => void released.push(handle) };
  const deps: WorkerDeps = {
    data: stores.connector,
    turn: {
      harness,
      prefilter,
      handlers,
      consumeTurnQuota: (clockId, quotaLog) => consumeQuota({ client: stores.client, now, log: quotaLog }, clockId, "AGENT_TURNS"),
      sessionKey: () => deriveSubkey(MASTER_KEY, "session"),
      runtimeSessionKey: () => deriveSubkey(MASTER_KEY, "runtime-session"),
      agentMode: "SCRIPTED",
      ...(options.reads === true ? { reads: createOperationsTarget({ connector: stores.connector, sessionKey: () => deriveSubkey(MASTER_KEY, "session"), wallClock: now, loggerFor: () => log }) } : {}),
    },
    handlers,
    escalation: escalationPort(stores, escalations),
    sink,
    reader: { health: async () => (options.readerOk === false ? Promise.reject(new Error("reader down")) : { status: "ok" as const, readerVersion: "mock-1" }) },
    queue,
    now,
    loggerFor: () => log,
  };
  const worker = createOperationWorker(deps);
  return {
    stores,
    harness,
    prefilter,
    handlers,
    escalations,
    sent,
    released,
    lines,
    deps,
    sink,
    log,
    advanceReal: (ms) => void (realMs += ms),
    realNow: now,
    deliver: (event, receiveCount = 1) => worker(sqsEvent(event, receiveCount)),
    metrics: (name) => lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["metric"] === name),
  };
}

export function sqsRecord(body: unknown, receiveCount = 1, receiptHandle = "receipt-1"): SQSRecord {
  return {
    messageId: "00000000-0000-4000-8000-000000000001",
    receiptHandle,
    body: typeof body === "string" ? body : JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: String(receiveCount),
      SentTimestamp: String(Date.parse(REAL_NOW)),
      SenderId: "AIDAEXAMPLE",
      ApproximateFirstReceiveTimestamp: String(Date.parse(REAL_NOW)),
      MessageGroupId: OPERATION,
    },
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:000000000000:operation-events.fifo",
    awsRegion: "us-east-1",
  };
}

export function sqsEvent(body: unknown, receiveCount = 1): SQSEvent {
  return { Records: [sqsRecord(body, receiveCount)] };
}

export interface TurnEventInput {
  readonly trigger?: TurnTrigger;
  readonly key?: string;
  readonly messageId?: string;
  readonly operationId?: string;
  readonly clockId?: string;
  readonly firmId?: string;
  readonly milestone?: TurnEvent["milestone"];
}

export function turnEvent(input: TurnEventInput = {}): OperationQueueEventInput {
  const trigger = input.trigger ?? "MILESTONE";
  return {
    type: "AGENT_TURN",
    eventId: turnEventId(trigger, input.key ?? `${input.operationId ?? OPERATION}#1`),
    operationId: input.operationId ?? OPERATION,
    clockId: input.clockId ?? CLOCK,
    firmId: input.firmId ?? FIRM,
    eventAtSim: START_SIM,
    trigger,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
  };
}

export interface InboundInput {
  readonly messageId: string;
  readonly body: string;
  readonly from?: "IMPORTER" | "SUPPLIER";
  readonly operationId?: string;
  readonly clockId?: string;
  readonly firmId?: string;
}

/** An inbound message already normalized and masked, as the channel entries store it. */
export async function seedInbound(stores: MemoryStores, input: InboundInput): Promise<void> {
  const supplier = input.from === "SUPPLIER";
  await stores.connector.conversations.appendMessage({
    messageId: input.messageId,
    operationId: input.operationId ?? OPERATION,
    firmId: input.firmId ?? FIRM,
    clockId: input.clockId ?? CLOCK,
    direction: "IN",
    channel: supplier ? "EMAIL" : "WHATSAPP",
    counterpart: supplier ? "SUPPLIER" : "IMPORTER",
    ...(supplier ? { contactId: "ctc-qingdao-1" } : { importerId: "imp-norpampa" }),
    to: supplier ? "op-4471-k7p2q9@legajo.demo.craftech.io" : "+5491100000000",
    from: supplier ? "supplier-qingdao@sim.legajo.demo.craftech.io" : "+5491155500101",
    body: input.body,
    status: "RECEIVED",
    author: supplier ? "SUPPLIER" : "IMPORTER",
    trusted: true,
    sentAtSim: START_SIM,
    sentAtReal: REAL_NOW,
  });
}

/** The firm takes the conversation (`control = BROKER`, FL-069). */
export async function takeControl(stores: MemoryStores, operationId: string = OPERATION): Promise<void> {
  await stores.connector.operations.setControl({ operationId, control: "BROKER", atSim: START_SIM, by: "BROKER:brk-delta-diego" });
}

/** Rows of `AuditLog` of the operation with `action`. */
export async function auditActions(stores: MemoryStores, operationId: string = OPERATION): Promise<string[]> {
  return (await stores.connector.audit.listByOperation(operationId)).map((decision) => decision.action ?? decision.decision);
}

/** The events the worker enqueued, parsed back. */
export function enqueued(world: Pick<WorkerWorld, "sent">): Array<Record<string, unknown>> {
  return world.sent.map((input) => JSON.parse(input.MessageBody ?? "{}") as Record<string, unknown>);
}
