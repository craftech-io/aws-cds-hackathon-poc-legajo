// `FeedEvents` (docs/architecture-integrations.md §6): the target of the `Feeds` bus rule, which
// carries the customs platform's `CarrierEtaChanged` and `CustomsStatusChanged`. In order:
//
//   1. the envelope is validated with the platform's own schema (`FeedEventEnvelope`); a malformed one
//      is dropped and counted (`FeedEventInvalid`), never retried into the queue;
//   2. duplicates by `detail.eventId` (`Runtime/IDEMP#FEED#<eventId>`) are dropped: the mock re-publishes
//      the same id for a repeated `Idempotency-Key` (FL-064, FL-078 a);
//   3. the operation is resolved by firm **and** number (numbers repeat between guest firms), in the
//      live epoch of its world; none → `FeedOperationUnknown`, nothing enqueued;
//   4. a customs status of a dossier that is not `APPROVED` is recorded as `DISPATCH_BEFORE_APPROVAL`
//      (an `ACTION` the console shows) and never reaches the importer (FL-078 b);
//   5. otherwise `ETA_CHANGED` or `DISPATCH_STATUS` is enqueued with the feed's `eventId` as is
//      (`inFlight` first, then `SendMessage`, worker/sink.ts), and only then the event is marked seen.
//
// The simulated instant of the event is the one the platform stamped (`occurredAtSim`).
import { FeedEventEnvelope } from "@legajo/platform-mock/events";
import type { z } from "zod";
import { countMetric } from "../channels/adapter";
import type { Connector } from "../connector/connector";
import type { Operation } from "../domain/operations";
import type { Logger } from "../lib/log";
import type { DispatchStatusEvent, EtaChangedEvent } from "../worker/events";

/** `IDEMP#FEED#<eventId>`: a feed event already handed to the queue (or deliberately not). */
export const FEED_SEEN_SOURCE = "FEED";

/** `AuditLog` action of a customs status that arrived before the firm approved the dossier. */
export const DISPATCH_BEFORE_APPROVAL = "DISPATCH_BEFORE_APPROVAL";

export const FEED_METRICS = {
  invalid: "FeedEventInvalid",
  unknownOperation: "FeedOperationUnknown",
  beforeApproval: "DispatchBeforeApproval",
} as const;

export type FeedEnvelope = z.infer<typeof FeedEventEnvelope>;

export type FeedOutcome = "ENQUEUED" | "DUPLICATE" | "UNKNOWN_OPERATION" | "BEFORE_APPROVAL" | "INVALID";

/** The producer of `OperationEvents.fifo` (worker/sink.ts `OperationEventSink`). */
export interface FeedEventSink {
  enqueue(event: EtaChangedEvent | DispatchStatusEvent): Promise<void>;
}

export interface FeedEventsDeps {
  readonly data: Pick<Connector, "operations" | "world" | "runtime" | "audit">;
  readonly events: FeedEventSink;
  /** Real time: the idempotency stamp and the audit's `atReal`. */
  readonly wallClock: () => Date;
  readonly log: Logger;
}

/**
 * The operation `operationNumber` of `firmId` in the live epoch of its world. A firm holds one world,
 * so the number is unique inside it; an operation whose epoch was reset away is not a match.
 */
export async function resolveFeedOperation(data: FeedEventsDeps["data"], firmId: string, operationNumber: string): Promise<Operation | undefined> {
  const candidates = (await data.operations.listOperations(firmId)).filter((operation) => operation.operationNumber === operationNumber);
  for (const operation of candidates) {
    const clock = await data.world.findClock(operation.clockId);
    if (clock === undefined || clock.worldEpoch !== operation.worldEpoch) continue;
    if (await data.world.isTombstoned(operation.clockId, operation.worldEpoch)) continue;
    return operation;
  }
  return undefined;
}

/** The queue event a validated feed event becomes for its operation. */
export function feedQueueEvent(envelope: FeedEnvelope, operation: Operation): EtaChangedEvent | DispatchStatusEvent {
  const base = {
    eventId: envelope.detail.eventId,
    operationId: operation.operationId,
    clockId: operation.clockId,
    firmId: operation.firmId,
    eventAtSim: envelope.detail.occurredAtSim,
    occurredAtSim: envelope.detail.occurredAtSim,
  };
  if (envelope["detail-type"] === "CarrierEtaChanged") {
    return { ...base, type: "ETA_CHANGED", eta: envelope.detail.newEta, previousEta: envelope.detail.previousEta };
  }
  return { ...base, type: "DISPATCH_STATUS", status: envelope.detail.status, ...(envelope.detail.channel === undefined ? {} : { channel: envelope.detail.channel }) };
}

/** `DISPATCH_BEFORE_APPROVAL`, once per feed event and operation. */
export async function recordDispatchBeforeApproval(
  data: Pick<Connector, "audit">,
  input: { readonly operation: Operation; readonly eventId: string; readonly status: string; readonly channel?: string; readonly atSim: string; readonly atReal: string },
): Promise<void> {
  const { operation } = input;
  await data.audit.recordOnce(`${DISPATCH_BEFORE_APPROVAL}#${operation.operationId}#${input.eventId}`, {
    firmId: operation.firmId,
    decision: "ACTION",
    action: DISPATCH_BEFORE_APPROVAL,
    actor: "SYSTEM",
    clockId: operation.clockId,
    operationId: operation.operationId,
    refs: { operationId: operation.operationId, eventId: input.eventId },
    atSim: input.atSim,
    atReal: input.atReal,
    reason: `customs status ${input.status} before the dossier was approved: not sent to the importer`,
    detail: { status: input.status, ...(input.channel === undefined ? {} : { channel: input.channel }), dossierStatus: operation.dossierStatus },
  });
}

async function markSeen(deps: FeedEventsDeps, eventId: string, outcome: FeedOutcome, atReal: string): Promise<void> {
  await deps.data.runtime.claimIdempotency({ source: FEED_SEEN_SOURCE, id: eventId, atReal, result: { outcome } });
}

export async function processFeedEvent(raw: unknown, deps: FeedEventsDeps): Promise<FeedOutcome> {
  const parsed = FeedEventEnvelope.safeParse(raw);
  if (!parsed.success) {
    countMetric(deps.log, FEED_METRICS.invalid, { issues: parsed.error.issues.length });
    return "INVALID";
  }
  const envelope = parsed.data;
  const { eventId, firmId, operationNumber } = envelope.detail;
  if ((await deps.data.runtime.getIdempotency(FEED_SEEN_SOURCE, eventId)) !== undefined) {
    deps.log.info("feed.duplicate", { eventId, type: envelope["detail-type"] });
    return "DUPLICATE";
  }
  const atReal = deps.wallClock().toISOString();
  const operation = await resolveFeedOperation(deps.data, firmId, operationNumber);
  if (operation === undefined) {
    countMetric(deps.log, FEED_METRICS.unknownOperation, { type: envelope["detail-type"] });
    await markSeen(deps, eventId, "UNKNOWN_OPERATION", atReal);
    return "UNKNOWN_OPERATION";
  }
  if (envelope["detail-type"] === "CustomsStatusChanged" && operation.dossierStatus !== "APPROVED") {
    await recordDispatchBeforeApproval(deps.data, {
      operation,
      eventId,
      status: envelope.detail.status,
      ...(envelope.detail.channel === undefined ? {} : { channel: envelope.detail.channel }),
      atSim: envelope.detail.occurredAtSim,
      atReal,
    });
    countMetric(deps.log, FEED_METRICS.beforeApproval, { status: envelope.detail.status });
    await markSeen(deps, eventId, "BEFORE_APPROVAL", atReal);
    return "BEFORE_APPROVAL";
  }
  const event = feedQueueEvent(envelope, operation);
  await deps.events.enqueue(event);
  await markSeen(deps, eventId, "ENQUEUED", atReal);
  deps.log.info("feed.enqueued", { eventId, type: event.type, operationId: operation.operationId });
  return "ENQUEUED";
}
