// Fixtures of the intake tests and of `read_document`'s: the demo slice with its firm, a scripted
// reader (one answer per call, or a failure), in-memory `Documents`, sources and timers, and a sink
// that keeps the events the intake enqueues. Everything the stage does over S3, the reader's
// Function URL, Scheduler and SQS is replaced here; the connector is the real one over memory.
import { DocType } from "@legajo/shared";
import type { Reading, ReadingObservation } from "@legajo/reader-contract";
import { type ChannelEvent, IntakeDocumentEvent, derivedEventId } from "../channels/adapter";
import { CLOCK, FIRM, REAL_NOW, START_SIM, memoryStores, seedDemoSlice } from "../connector/testing";
import type { MemoryStores } from "../connector/memory/index";
import type { Timer } from "../domain/timers";
import { sha256Hex } from "../lib/crypto";
import { createLogger } from "../lib/log";
import type { CreateReadingInput } from "../reader/client";
import { ReaderError } from "../reader/errors";
import { seedFirm } from "../agent-tools/operations/testing";
import { recordEscalation } from "./escalation-rules";
import type { EscalationRequest, IntakeDeps } from "./ports";

export const OPERATION_ID = "op-4471";

/** A minimal PDF whose bytes differ by `label`, so each test file has its own SHA-256. */
export function pdfBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n% ${label}\n%%EOF\n`);
}

export type ReaderScript = Reading | "FAIL";

export function recognized(docType: DocType, observations: readonly ReadingObservation[] = [], extra: Partial<Reading> = {}): Reading {
  return { readingId: `rd-${docType}`, status: "RECOGNIZED", docType, confidence: 0.97, matchedBy: "SHA256", fields: { invoiceNumber: "QBT-2026-0917" }, observations: [...observations], readerVersion: "1.0.0", ...extra };
}

export const UNRECOGNIZED: Reading = { readingId: "rd-unknown", status: "UNRECOGNIZED", readerVersion: "1.0.0" };

export const GROSS_WEIGHT: ReadingObservation = { code: "GROSS_WEIGHT_MISMATCH", severity: "BLOCKING", field: "grossWeightKg", expected: "12840", found: "12480", againstDocType: "COMMERCIAL_INVOICE" };

export interface IntakeWorld {
  readonly stores: MemoryStores;
  readonly deps: IntakeDeps;
  /** Readings the reader gives, in order; an empty script fails the test loudly. */
  readonly script: ReaderScript[];
  readonly readerCalls: CreateReadingInput[];
  /** `Documents` by key. */
  readonly objects: Map<string, Uint8Array>;
  /** Source objects by key (Uploads, Media or an email's attachment). */
  readonly sources: Map<string, Uint8Array>;
  readonly timers: Timer[];
  readonly events: ChannelEvent[];
  readonly escalations: EscalationRequest[];
  /** Puts `bytes` as a source object and returns the event that names it. */
  event(bytes: Uint8Array, overrides?: Partial<IntakeDocumentEvent>): IntakeDocumentEvent;
}

let eventSequence = 0;

export async function intakeWorld(): Promise<IntakeWorld> {
  const stores = memoryStores();
  await seedDemoSlice(stores);
  await seedFirm(stores);
  await stores.connector.world.createClock({ clockId: CLOCK, firmId: FIRM, mode: "PAUSED", pausedSimNow: START_SIM, startAtSim: START_SIM, worldEpoch: 1 });
  const script: ReaderScript[] = [];
  const readerCalls: CreateReadingInput[] = [];
  const objects = new Map<string, Uint8Array>();
  const sources = new Map<string, Uint8Array>();
  const timers: Timer[] = [];
  const events: ChannelEvent[] = [];
  const escalations: EscalationRequest[] = [];
  const wallClock = () => new Date(REAL_NOW);
  const record = recordEscalation(stores.connector, wallClock);
  const deps: IntakeDeps = {
    connector: stores.connector,
    reader: {
      async createReading(input) {
        readerCalls.push(input);
        const next = script.shift();
        if (next === undefined) throw new Error("the test gave the reader no answer");
        if (next === "FAIL") throw new ReaderError("READER_UNAVAILABLE", "reader down", { attempts: 3, status: 503 });
        return next;
      },
    },
    documents: {
      async put(key, bytes) {
        objects.set(key, bytes);
      },
      async delete(key) {
        objects.delete(key);
      },
      sourceUrl: async (key) => `https://documents.example.invalid/${encodeURIComponent(key)}?X-Amz-Expires=300`,
    },
    escalate: async (request) => {
      escalations.push(request);
      return record(request);
    },
    wallClock,
    log: createLogger({ level: "error", sink: () => undefined }),
    matrixOf: (firmId) => stores.connector.firms.getResponsibilityMatrix(firmId),
    sources: {
      async read(object) {
        const bytes = sources.get(object.key);
        if (bytes === undefined) throw new Error(`no source object ${object.key}`);
        return bytes;
      },
    },
    timers: {
      async schedule(timer) {
        const created = await stores.connector.timers.createTimer({ ...timer, status: "SCHEDULED", payload: { ...(timer.payload ?? {}) } });
        timers.push(created);
        return created;
      },
    },
    events: {
      async enqueue(event) {
        events.push(event);
      },
    },
  };
  return {
    stores,
    deps,
    script,
    readerCalls,
    objects,
    sources,
    timers,
    events,
    escalations,
    event(bytes, overrides = {}) {
      eventSequence += 1;
      const key = `uploads/test/${eventSequence}.pdf`;
      sources.set(key, bytes);
      return IntakeDocumentEvent.parse({
        type: "INTAKE_DOCUMENT",
        eventId: derivedEventId("INTAKE_DOCUMENT", `test-${eventSequence}`),
        operationId: OPERATION_ID,
        clockId: CLOCK,
        firmId: FIRM,
        eventAtSim: START_SIM,
        source: { party: "SUPPLIER", channel: "EMAIL", contactId: "ctc-qingdao-1" },
        object: { store: "UPLOADS", key },
        sha256: sha256Hex(bytes),
        sizeBytes: bytes.length,
        ...overrides,
      });
    },
  };
}
