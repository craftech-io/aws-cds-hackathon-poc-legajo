// Test kit of the direct handlers: the console's world over the in-memory connector (routers/testing.ts:
// `firm-delta` with operation 4471 and its parties, `firm-norte`, `firm-qa` and, when asked, the reserved
// guest firm `firm-guest-01`, all paused at Wed 14/10 10:30), the real timers over an in-memory
// Scheduler, a sink that records what would go to `OperationEvents.fifo`, a scripted platform, scripted
// approvals and deferred sends, and a logger whose metric lines can be read back. Real time is fixed
// unless a test moves it.
import type { PlatformOperation } from "@legajo/platform-mock/schema";
import { type Caller, type ConsoleRole, type DocStatus, type DocType, ToolError } from "@legajo/shared";
import type { MemoryStores } from "../../connector/index";
import { sequentialIds } from "../../connector/memory/index";
import { CLOCK, FIRM, REAL_NOW, START_SIM, hashOf, memoryStores } from "../../connector/testing";
import type { VersionState } from "../../domain/documents";
import { type Logger, createLogger } from "../../lib/log";
import type { MilestoneDeps } from "../../milestones/schedule";
import { GUEST_FIRM, seedConsoleWorld } from "../../routers/testing";
import { fakeScheduler } from "../../sim-mail/testing";
import type { DueTimer } from "../../timers/timers";
import type { OperationQueueEventInput } from "../../worker/events";
import type { OperationEventSink } from "../../worker/sink";
import type { DeferredOutcome, ServiceDeps } from "./ports";

export { CLOCK, FIRM, GUEST_FIRM, REAL_NOW, START_SIM };
export const GUEST_CLOCK = `GUEST#${GUEST_FIRM}`;
export const OPERATION = "op-4471";

export interface ServiceWorld {
  readonly stores: MemoryStores;
  readonly deps: ServiceDeps;
  /** Events the handlers enqueued, in order. */
  readonly events: OperationQueueEventInput[];
  readonly dispatched: DueTimer[];
  readonly approvals: Array<{ readonly operationId: string; readonly atSim: string }>;
  readonly resent: Array<{ readonly messageId: string; readonly timerKey: string; readonly atSim: string }>;
  readonly scheduler: ReturnType<typeof fakeScheduler>;
  /** Platform rows by `<firmId>#<number>`. */
  readonly platform: Map<string, PlatformOperation>;
  readonly lines: string[];
  advanceReal(ms: number): void;
  /** Metric lines written so far (`metric <name>`). */
  metrics(name: string): Array<Record<string, unknown>>;
}

export interface ServiceWorldOptions {
  readonly guestWorld?: boolean;
  /** What the pipeline answers for a deferred message. */
  readonly deferred?: { readonly status: DeferredOutcome; readonly nextAllowedAt?: string };
}

export function recordingSink(events: OperationQueueEventInput[]): OperationEventSink {
  return { enqueue: async (event: OperationQueueEventInput) => void events.push(event) };
}

export async function serviceWorld(options: ServiceWorldOptions = {}): Promise<ServiceWorld> {
  let realMs = Date.parse(REAL_NOW);
  const wallClock = (): Date => new Date(realMs);
  const stores = memoryStores();
  await seedConsoleWorld(stores, { guestWorld: options.guestWorld ?? false });
  const lines: string[] = [];
  const log: Logger = createLogger({ sink: (line) => lines.push(line), now: wallClock, level: "debug" });
  const events: OperationQueueEventInput[] = [];
  const dispatched: DueTimer[] = [];
  const approvals: ServiceWorld["approvals"] = [];
  const resent: ServiceWorld["resent"] = [];
  const scheduler = fakeScheduler();
  const platform = new Map<string, PlatformOperation>();
  const timers: MilestoneDeps = { data: stores.connector, scheduler, dispatcher: { dispatch: async (due) => void dispatched.push(due) }, realClock: wallClock, log };
  const deps: ServiceDeps = {
    connector: stores.connector,
    wallClock,
    loggerFor: () => log,
    events: recordingSink(events),
    timers,
    approvals: { requestApproval: async (input) => void approvals.push({ operationId: input.operationId, atSim: input.atSim }) },
    deferred: {
      resend: async (input) => {
        resent.push({ messageId: input.messageId, timerKey: input.timerKey, atSim: input.atSim });
        return options.deferred ?? { status: "SENT" };
      },
    },
    platform: {
      get: async (firmId, operationNumber) => {
        const row = platform.get(`${firmId}#${operationNumber}`);
        if (row === undefined) throw new ToolError("NOT_FOUND", "no such operation", "PLATFORM_NOT_FOUND");
        return row;
      },
    },
    keys: { phoneHash: hashOf, emailHash: hashOf, threadKey: () => new TextEncoder().encode("legajo-services-tests-thread-key") },
    demoRecipients: () => [],
    quotaTable: stores.client,
    newId: sequentialIds("T"),
  };
  return {
    stores,
    deps,
    events,
    dispatched,
    approvals,
    resent,
    scheduler,
    platform,
    lines,
    advanceReal: (ms) => void (realMs += ms),
    metrics: (name) => lines.filter((line) => line.includes(`"metric":"${name}"`)).map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const BROKERS: Readonly<Record<string, Partial<Record<ConsoleRole, string>>>> = {
  [FIRM]: { BROKER: "brk-delta-diego", ANALYST: "brk-delta-martina" },
  "firm-norte": { BROKER: "brk-norte-pablo" },
  [GUEST_FIRM]: { GUEST: "brk-guest-01" },
};

/** The console's caller for a persona of the seed (the server builds it from the principal). */
export function consoleCaller(firmId: string = FIRM, role: ConsoleRole = "BROKER"): Caller {
  const brokerId = BROKERS[firmId]?.[role] ?? `brk-${firmId.replace(/^firm-/, "")}-x`;
  return { kind: "CONSOLE", firmId, brokerId, role };
}

/** A platform row of `firmId` for the parties of the demo slice (or the ones given). */
export function platformRow(firmId: string, operationNumber: string, overrides: Partial<PlatformOperation> = {}): PlatformOperation {
  return {
    firmId,
    operationNumber,
    importerId: "imp-norpampa",
    supplierId: "sup-qingdao",
    vessel: "Austral Aurora",
    carrier: "Austral Line",
    regime: "Importación para consumo",
    port: "Qingdao",
    eta: "2026-10-30T08:00:00-03:00",
    invoiceNumber: "QBT-2026-0999",
    incoterm: "FOB",
    incotermPlace: "Qingdao",
    documents: { COMMERCIAL_INVOICE: "MISSING", PACKING_LIST: "MISSING", CERTIFICATE_OF_ORIGIN: "MISSING" },
    customs: { status: "NONE" },
    ...overrides,
  };
}

// ---- Dossier fixtures of op-4471 --------------------------------------------------------------------

const SHORT: Readonly<Record<DocType, string>> = { COMMERCIAL_INVOICE: "CI", PACKING_LIST: "PL", CERTIFICATE_OF_ORIGIN: "CO" };

/** Files version `versionNo` of a document of op-4471 in `state` (a key built like the intake's). */
export async function fileVersion(world: ServiceWorld, docType: DocType, state: VersionState, versionNo = 1): Promise<string> {
  const { version } = await world.stores.connector.documents.addVersion({
    version: {
      operationId: OPERATION,
      clockId: CLOCK,
      docType,
      versionNo,
      s3Key: `ops/${OPERATION}/${docType}/v${String(versionNo).padStart(3, "0")}-0a1b2c3d.pdf`,
      sha256: String(versionNo).repeat(64).slice(0, 64),
      sizeBytes: 2048,
      source: { party: "SUPPLIER", channel: "EMAIL" },
      receivedAtSim: START_SIM,
      state,
    },
  });
  return version.docVersionId;
}

/** A blocking observation of a read version, open. */
export async function openObservation(world: ServiceWorld, docType: DocType, docVersionId: string): Promise<string> {
  const observation = await world.stores.connector.documents.createObservation({
    observationId: `obs-4471-${SHORT[docType]}-GROSS_WEIGHT_MISMATCH`,
    operationId: OPERATION,
    clockId: CLOCK,
    docType,
    code: "GROSS_WEIGHT_MISMATCH",
    severity: "BLOCKING",
    expected: "12840",
    found: "12480",
    status: "OPEN",
    firstDocVersionId: docVersionId,
    lastDocVersionId: docVersionId,
    created: { atSim: START_SIM, by: "SYSTEM" },
  });
  return observation.observationId;
}

/** Sets the status of the documents of op-4471 straight through the connector. */
export async function setDocuments(world: ServiceWorld, statuses: Partial<Record<DocType, DocStatus>>): Promise<void> {
  for (const [docType, status] of Object.entries(statuses) as Array<[DocType, DocStatus]>) await world.stores.connector.documents.updateDocument(OPERATION, docType, { status });
}

/** op-4471 complete and `READY_FOR_REVIEW`, as `request_approval` leaves it. */
export async function readyForReview(world: ServiceWorld): Promise<void> {
  await setDocuments(world, { COMMERCIAL_INVOICE: "VALID", PACKING_LIST: "VALID", CERTIFICATE_OF_ORIGIN: "VALID" });
  await world.stores.connector.operations.transitionDossier({ operationId: OPERATION, to: "READY_FOR_REVIEW", atSim: START_SIM, by: "AGENT" });
}
