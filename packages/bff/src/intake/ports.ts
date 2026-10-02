// What the intake needs from the outside (docs/tool-catalog.md `intake_document`, docs/architecture.md
// §6-§8, docs/architecture-integrations.md §5): the connector, the one reader client, the buckets a
// PDF moves through, the timers of the world, the escalation path and the operation's queue. The
// worker wires the production ports (intake/storage.ts, the timers and escalations modules, its queue
// sink); the tests wire in-memory ones. Nothing here reads `Resource`.
import type { EscalationReason } from "@legajo/shared";
import type { ChannelEventSink, IntakeObject } from "../channels/adapter";
import type { Connector } from "../connector/connector";
import type { ResponsibilityMatrix } from "../domain/firms";
import type { Operation } from "../domain/operations";
import type { Timer } from "../domain/timers";
import type { Logger } from "../lib/log";
import type { ReaderClient } from "../reader/client";
import type { TimerSpec } from "../timers/timers";

/** The bytes of the PDF an `INTAKE_DOCUMENT` names: an email attachment, an upload or a WhatsApp media. */
export interface SourceStore {
  /** The object's bytes; throws when it is missing or over the limit of its store. */
  read(object: IntakeObject, sha256: string): Promise<Uint8Array>;
}

/** The `Documents` bucket, under keys built by code only (docs/architecture.md §6). */
export interface DocumentStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Pre-signed GET of 5 minutes the reader downloads with (reader/source-url.ts). */
  sourceUrl(key: string): Promise<string>;
}

/** Creates a `TIMER#` of the world (and its schedule while the world is RUNNING, docs/architecture.md §8). */
export interface TimerScheduler {
  schedule(timer: TimerSpec): Promise<Timer>;
}

/** An escalation decided by code (docs/design-brief.md §5.8), with its summary already composed. */
export interface EscalationRequest {
  readonly reason: EscalationReason;
  readonly operation: Pick<Operation, "operationId" | "operationNumber" | "firmId" | "clockId">;
  /** At most 500 characters, without personal data (words from copy/ only). */
  readonly summary: string;
  readonly atSim: string;
  readonly observationId?: string;
  readonly docVersionId?: string;
  /** Whether the reason also sends the email to the firm's mailbox (docs/tool-catalog.md `escalate_to_broker`). */
  readonly notifyFirm: boolean;
}

export interface EscalationOutcome {
  readonly escalationId: string;
  readonly created: boolean;
}

/** Opens the escalation (one OPEN per reason and operation) and, when `notifyFirm`, mails the firm. */
export type Escalate = (request: EscalationRequest) => Promise<EscalationOutcome>;

/** Everything a reading needs: enough for the worker, and for `read_document` in its own Lambda. */
export interface ReadingDeps {
  readonly connector: Connector;
  readonly reader: Pick<ReaderClient, "createReading">;
  /** Only the reader's pre-signed GET: reading a filed version never writes an object. */
  readonly documents: Pick<DocumentStore, "sourceUrl">;
  readonly escalate: Escalate;
  /** Real time: `atReal` stamps only; business time is always the world's (ADR-0007). */
  readonly wallClock: () => Date;
  readonly log: Logger;
  /**
   * The firm's responsibility matrix, to stamp `matrixDefault` on new observations. `ToolDocuments`
   * does not hold `Firms` (docs/architecture.md §14): without it the stamp waits for `assign_responsible`.
   */
  readonly matrixOf?: (firmId: string) => Promise<ResponsibilityMatrix | undefined>;
}

/** The worker's intake: a reading plus where the PDF comes from, the timers and the queue. */
export interface IntakeDeps extends ReadingDeps {
  readonly documents: DocumentStore;
  readonly sources: SourceStore;
  readonly timers: TimerScheduler;
  readonly events: ChannelEventSink;
}
