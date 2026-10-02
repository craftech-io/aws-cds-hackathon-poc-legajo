// Test world of the time modules (timers, milestones, clock, escalations, followups, handoff): the demo
// slice of connector/testing.ts (`firm-delta`, `op-4471` with ETA 22/10 08:00, `imp-norpampa`,
// `sup-qingdao` in Asia/Shanghai) with the firm, its settings (5 free days, USD 160-180 a day, three
// `UNTRUSTED_SENDER` emails a day) and the clock `GLOBAL#firm-delta` at 14/10 10:30, plus recording
// fakes for every port: the Scheduler, the queue, `SimMail` and the outbound pipeline. Real time is
// settable. Nothing here ships in a Lambda.
import type { TimerKind } from "@legajo/shared";
import { seedFirm } from "../agent-tools/operations/testing";
import type { MemoryStores } from "../connector/memory/index";
import { CLOCK, FIRM, REAL_NOW, START_SIM, memoryStores, seedDemoSlice } from "../connector/testing";
import type { Connector } from "../connector/connector";
import type { NewEntity } from "../domain/common";
import type { Timer } from "../domain/timers";
import { createLogger, type Logger } from "../lib/log";
import type { OutboundCall, OutboundRequest, OutboundResult } from "../outbound/types";
import type { SimReplyHandoff, TimerEvent } from "../timers/events";
import type { ScheduleSpec, SchedulerPort } from "../timers/scheduler-client";
import { type TimerDeps, timerDispatcher, timerEventOf } from "../timers/timers";
import type { OperationQueueEventInput } from "../worker/events";
import type { WorkerContext } from "../worker/ports";
import type { OperationEventSink } from "../worker/sink";
import { timeHandlers } from "./handlers";

export { CLOCK, FIRM, REAL_NOW, START_SIM };
export const OPERATION = "op-4471";
export const ETA = "2026-10-22T08:00:00-03:00";
export const FIRM_MAILBOX = "estudio-delta@sim.legajo.demo.craftech.io";

const META = { createdAt: REAL_NOW, updatedAt: REAL_NOW, version: 1, synthetic: true };

export interface FakeScheduler extends SchedulerPort {
  readonly schedules: Map<string, ScheduleSpec>;
  readonly puts: ScheduleSpec[];
  readonly deletes: string[];
}

export function fakeScheduler(): FakeScheduler {
  const schedules = new Map<string, ScheduleSpec>();
  const puts: ScheduleSpec[] = [];
  const deletes: string[] = [];
  return {
    schedules,
    puts,
    deletes,
    async put(spec) {
      puts.push(spec);
      schedules.set(spec.name, spec);
    },
    async delete(name) {
      deletes.push(name);
      schedules.delete(name);
    },
  };
}

export interface SentRecord {
  readonly request: OutboundRequest;
  readonly call: OutboundCall;
}

export interface TimeWorld {
  readonly stores: MemoryStores;
  readonly connector: Connector;
  readonly scheduler: FakeScheduler;
  /** Every event the queue received (`TIMER`, `AGENT_TURN`…). */
  readonly enqueued: OperationQueueEventInput[];
  readonly handoffs: SimReplyHandoff[];
  readonly sent: SentRecord[];
  readonly lines: string[];
  readonly log: Logger;
  readonly sink: OperationEventSink;
  /** What the fake pipeline answers next (SENT by default). */
  sendStatus: OutboundResult["status"];
  realNow: Date;
  readonly wallClock: () => Date;
  timerDeps(): TimerDeps & { readonly data: Connector };
  workerContext(): WorkerContext;
  send(request: OutboundRequest, call: OutboundCall): Promise<OutboundResult>;
  /** Moves the world's clock to RUNNING at `simNow` (offset from the current real time) for 30 minutes. */
  run(simNow: string): Promise<void>;
  /** A SCHEDULED timer written straight to the connector. */
  timer(kind: TimerKind, timerId: string, dueAtSim: string, overrides?: Partial<NewEntity<typeof Timer>>): Promise<Timer>;
  /** Marks documents of op-4471 `VALID`. */
  validate(...docTypes: ("COMMERCIAL_INVOICE" | "PACKING_LIST" | "CERTIFICATE_OF_ORIGIN")[]): Promise<void>;
}

/** `FirmSettings` of the demo firm: 5 free days, USD 160-180 a day, three `UNTRUSTED_SENDER` emails a day. */
export async function seedSettings(stores: MemoryStores): Promise<void> {
  const label = "supuesto";
  await stores.seed.loadItems("Firms", [
    {
      PK: `FIRM#${FIRM}`,
      SK: "SETTINGS",
      entity: "FirmSettings",
      ...META,
      firmId: FIRM,
      manualBaseline: { items: [{ action: "Contactos por legajo", count: 8, minutes: 8, label }], source: "Estimación propia del equipo", label },
      humanActionMinutes: { items: [{ action: "APPROVE", minutes: 10, label }], source: "Estimación propia del equipo", label },
      assumptions: { freeDaysAtPort: 5, demurrageUsdPerDay: { min: 160, max: 180 }, source: "Fuentes secundarias no verificadas", label },
      costBudgetUsdPerDossier: 5,
      turnCaps: { perHour: 200, perDay: 1000 },
      untrustedSenderEmailsPerDay: 3,
    },
  ]);
}

export async function timeWorld(): Promise<TimeWorld> {
  const stores = memoryStores();
  await seedDemoSlice(stores);
  await seedFirm(stores);
  await seedSettings(stores);
  const { connector } = stores;
  await connector.world.createClock({ clockId: CLOCK, firmId: FIRM, mode: "PAUSED", pausedSimNow: START_SIM, startAtSim: START_SIM, worldEpoch: 1 });
  const lines: string[] = [];
  const enqueued: OperationQueueEventInput[] = [];
  const handoffs: SimReplyHandoff[] = [];
  const sent: SentRecord[] = [];
  const scheduler = fakeScheduler();
  const sink: OperationEventSink = { enqueue: async (event) => void enqueued.push(event) };
  let sends = 0;
  const world: TimeWorld = {
    stores,
    connector,
    scheduler,
    enqueued,
    handoffs,
    sent,
    lines,
    sink,
    sendStatus: "SENT",
    realNow: new Date(REAL_NOW),
    wallClock: () => new Date(world.realNow.getTime()),
    log: createLogger({ correlationId: "corr-time-test", level: "debug", sink: (line) => lines.push(line), now: () => new Date(REAL_NOW) }),
    timerDeps() {
      return { data: connector, scheduler, dispatcher: timerDispatcher({ events: sink, simReply: async (handoff) => void handoffs.push(handoff) }), realClock: world.wallClock, log: world.log };
    },
    workerContext() {
      return { log: world.log, sink, now: world.wallClock, receiveCount: 1 };
    },
    async send(request, call) {
      sent.push({ request, call });
      sends += 1;
      const messageId = request.messageId ?? `msg-fake${sends}`;
      if (world.sendStatus === "SENT") return { status: "SENT", messageId, providerMessageId: `prov-${sends}` } as unknown as OutboundResult;
      if (world.sendStatus === "DEFERRED") return { status: "DEFERRED", messageId, nextAllowedAt: "2026-10-26T09:00:00-03:00", timerKey: `TIMER#DEFERRED_SEND#${sends}` } as unknown as OutboundResult;
      return { status: "REFUSED", failure: { ok: false, error: { code: "POLICY_DENIED", message: "denied" } }, ruleIds: [] } as unknown as OutboundResult;
    },
    async run(simNow) {
      const clock = await connector.world.getClock(CLOCK);
      const now = world.realNow.getTime();
      await connector.world.updateClock(CLOCK, { mode: "RUNNING", offsetMs: Date.parse(simNow) - now, pausedSimNow: simNow, runningUntilReal: new Date(now + 30 * 60_000).toISOString() }, clock.version);
    },
    async timer(kind, timerId, dueAtSim, overrides = {}) {
      return connector.timers.createTimer({ operationId: OPERATION, clockId: CLOCK, kind, timerId, dueAtSim, status: "SCHEDULED", payload: {}, ...overrides });
    },
    async validate(...docTypes) {
      for (const docType of docTypes) await connector.documents.updateDocument(OPERATION, docType, { status: "VALID" });
    },
  };
  return world;
}

/** The worker's time handlers over the world's fakes; the external actions record what they got. */
export function handlersOf(world: TimeWorld, external: string[] = []): ReturnType<typeof timeHandlers> {
  const record = (kind: string) => async () => (external.push(kind), { outcome: "FIRED" as const });
  return timeHandlers({
    data: world.connector,
    scheduler: world.scheduler,
    dispatcherFor: (sink) => timerDispatcher({ events: sink, simReply: async (handoff) => void world.handoffs.push(handoff) }),
    send: (request, call) => world.send(request, call),
    external: () => ({ DEFERRED_SEND: record("DEFERRED_SEND"), READER_RETRY: record("READER_RETRY"), BOUNCE_RETRY: record("BOUNCE_RETRY") }),
  });
}

/** The `TIMER` event of a stored timer, as the clock or a schedule would dispatch it. */
export async function timerEventFor(world: TimeWorld, timerKey: string, firedBy: "CLOCK" | "SCHEDULER" | "MANUAL" | "ETA_CHANGE" = "CLOCK", version?: number): Promise<TimerEvent> {
  const timer = await world.connector.timers.getTimer(OPERATION, timerKey);
  const event = timerEventOf({ timer, firmId: FIRM, firedBy, eventAtSim: timer.dueAtSim });
  return version === undefined ? event : { ...event, version };
}

/** Moves op-4471 to READY_FOR_REVIEW and, with `approve`, to APPROVED by a human broker. */
export async function advanceDossier(world: TimeWorld, approve: boolean): Promise<void> {
  const by = "BROKER:brk-delta-diego" as const;
  await world.connector.operations.transitionDossier({ operationId: OPERATION, to: "READY_FOR_REVIEW", atSim: "2026-10-15T09:00:00-03:00", by: "AGENT" });
  if (approve) await world.connector.operations.transitionDossier({ operationId: OPERATION, to: "APPROVED", approvedBy: "brk-delta-diego", atSim: "2026-10-15T09:30:00-03:00", by });
}

/** An outbound message of op-4471 that left (`SENT`), as the pipeline records it. */
export async function sentMessage(world: TimeWorld, input: { readonly messageId: string; readonly channel: "WHATSAPP" | "EMAIL"; readonly kind: "DOCS_REQUEST" | "REMINDER"; readonly sentAtSim: string }): Promise<void> {
  const toImporter = input.channel === "WHATSAPP";
  await world.connector.conversations.appendMessage({
    messageId: input.messageId,
    operationId: OPERATION,
    firmId: FIRM,
    clockId: CLOCK,
    channel: input.channel,
    kind: input.kind,
    counterpart: toImporter ? "IMPORTER" : "SUPPLIER",
    ...(toImporter ? { importerId: "imp-norpampa" } : { contactId: "ctc-qingdao-1" }),
    direction: "OUT",
    status: "SENT",
    author: "AGENT",
    to: toImporter ? "+5491155500101" : "supplier-qingdao@sim.legajo.demo.craftech.io",
    from: toImporter ? "simulated" : "op-4471-k7p2q9@legajo.demo.craftech.io",
    body: "Pedido",
    sentAtSim: input.sentAtSim,
    sentAtReal: REAL_NOW,
  });
}
