// Fixtures of the platform mock's tests, reusable by the local flows: operation 4471 of the demo firm as
// the seed describes it (docs/seed-spec.md §7, fictitious names), a clock that moves one second per
// read and deterministic event ids. Never imported by the Lambda.
import { createPlatformApp, type PlatformApp, type PlatformAppDeps } from "./app";
import { newPlatformEventId, type PlatformEventId } from "./events";
import type { PlatformRequest } from "./http";
import type { PlatformLogRecord } from "./log";
import { createRecordingPublisher, type PlatformEventPublisher, type RecordingPublisher } from "./publisher";
import { toPlatformOperationItem, type PlatformItemOptions, type PlatformOperationInput, type PlatformOperationItem } from "./schema";
import { createMemoryPlatformStore, type MemoryPlatformStore, type PlatformStore } from "./store";

export const FIXED_NOW = new Date("2026-09-25T12:00:00.000Z");

/** Operation 4471 of `firm-delta`: invoice valid, packing list and certificate missing, ETA 22/10 08:00. */
export function operation4471(overrides: Partial<PlatformOperationInput> = {}): PlatformOperationInput {
  return {
    firmId: "firm-delta",
    operationNumber: "4471",
    importerId: "imp-norpampa",
    supplierId: "sup-qingdao",
    vessel: "Austral Aurora",
    carrier: "Austral Line",
    regime: "Importación para consumo",
    port: "Buenos Aires",
    eta: "2026-10-22T08:00:00-03:00",
    invoiceNumber: "QBT-2026-0917",
    incoterm: "FOB",
    incotermPlace: "Qingdao",
    documents: { COMMERCIAL_INVOICE: "VALID", PACKING_LIST: "MISSING", CERTIFICATE_OF_ORIGIN: "MISSING" },
    ...overrides,
  };
}

export function operationItem(overrides: Partial<PlatformOperationInput> = {}, options: Partial<PlatformItemOptions> = {}): PlatformOperationItem {
  return toPlatformOperationItem(operation4471(overrides), { now: FIXED_NOW, ...options });
}

/** Real time that advances `stepMs` on every read, so event rows of one test never share a key. */
export function steppingClock(start: Date = FIXED_NOW, stepMs = 1_000): () => Date {
  let current = start.getTime();
  return () => {
    const now = new Date(current);
    current += stepMs;
    return now;
  };
}

/** `evt_…` ids that differ by a counter and repeat across runs. */
export function sequentialEventIds(start: Date = FIXED_NOW): () => PlatformEventId {
  let counter = 0;
  return () => {
    counter += 1;
    const seed = counter;
    return newPlatformEventId(start.getTime() + seed, (size) => Uint8Array.from({ length: size }, (_, index) => (seed * 31 + index) % 256));
  };
}

export interface PlatformFixture {
  readonly app: PlatformApp;
  readonly store: MemoryPlatformStore;
  readonly publisher: RecordingPublisher;
  readonly logs: PlatformLogRecord[];
}

export interface PlatformFixtureOptions {
  readonly items?: readonly PlatformOperationItem[];
  /** Wraps the memory store (fault injection); the fixture still exposes the memory store itself. */
  readonly wrapStore?: (store: MemoryPlatformStore) => PlatformStore;
  /** Wraps the recording publisher; events reach `publisher.events` only through the wrapped one. */
  readonly wrapPublisher?: (publisher: RecordingPublisher) => PlatformEventPublisher;
  readonly deps?: Partial<PlatformAppDeps>;
}

export function platformFixture(options: PlatformFixtureOptions = {}): PlatformFixture {
  const store = createMemoryPlatformStore(options.items ?? [operationItem()]);
  const publisher = createRecordingPublisher();
  const logs: PlatformLogRecord[] = [];
  const app = createPlatformApp({
    store: options.wrapStore ? options.wrapStore(store) : store,
    publisher: options.wrapPublisher ? options.wrapPublisher(publisher) : publisher,
    now: steppingClock(),
    newEventId: sequentialEventIds(),
    log: (record) => logs.push(record),
    ...options.deps,
  });
  return { app, store, publisher, logs };
}

export interface CallResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly json: unknown;
}

/** Sends a request to the app; `body` objects are serialized as JSON. */
export async function call(app: PlatformApp, method: string, url: string, init: { body?: unknown; headers?: Record<string, string> } = {}): Promise<CallResult> {
  const request: PlatformRequest = {
    method,
    url,
    headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
  };
  const response = await app.handle(request);
  return { status: response.status, headers: response.headers, json: JSON.parse(response.body) as unknown };
}

/** Error code, reason and message of an error answer. */
export function errorOf(result: CallResult): { code?: string; reason?: string; message?: string } {
  const body = result.json;
  if (typeof body !== "object" || body === null) return {};
  const error: unknown = Reflect.get(body, "error");
  return typeof error === "object" && error !== null ? (error as { code?: string; reason?: string; message?: string }) : {};
}
