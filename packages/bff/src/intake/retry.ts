// `TIMER#READER_RETRY` (docs/architecture.md §8, FL-096): a version the reader could not read is
// retried 30 simulated minutes later, again and again until it is read or `MAX_READER_ATTEMPTS`
// failed readings; the third failure escalates `READER_UNAVAILABLE` once and the retries go on, so
// when the reader comes back the reading completes the flow. A retry that reads the version opens a
// `DOCUMENT_READ` turn: the turn that followed the PDF ran without its reading.
import { z } from "zod";
import { DocVersionId, MessageId, OperationId } from "@legajo/shared";
import { AgentTurnEvent, turnEventId } from "../channels/adapter";
import type { DocumentVersion } from "../domain/documents";
import type { Operation } from "../domain/operations";
import type { Timer } from "../domain/timers";
import { timerEventId } from "../timers/events";
import type { TimerAction } from "../timers/fire";
import { pendingVersion, readPendingVersion } from "./pending";
import type { IntakeDeps, TimerScheduler } from "./ports";
import type { ReadResult } from "./reading";

/** Simulated minutes between two readings of the same version. */
export const READER_RETRY_DELAY_MINUTES = 30;

/** Failed readings after which no more retries are scheduled (the escalation is at the third). */
export const MAX_READER_ATTEMPTS = 8;

/** `payload` of a `TIMER#READER_RETRY`. */
export const ReaderRetryPayload = z.object({ docVersionId: DocVersionId, failures: z.number().int().min(1) }).strict();
export type ReaderRetryPayload = z.infer<typeof ReaderRetryPayload>;

function plusMinutes(instant: string, minutes: number): string {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

/** Schedules the next reading of `version` after its `failures`-th failure, unless retries ran out. */
export async function scheduleReaderRetry(timers: TimerScheduler, operation: Operation, version: Pick<DocumentVersion, "docVersionId">, failures: number, atSim: string): Promise<Timer | undefined> {
  if (failures >= MAX_READER_ATTEMPTS) return undefined;
  const payload: ReaderRetryPayload = { docVersionId: version.docVersionId, failures };
  return timers.schedule({
    operationId: operation.operationId,
    clockId: operation.clockId,
    kind: "READER_RETRY",
    timerId: `${version.docVersionId}-r${failures}`,
    dueAtSim: plusMinutes(atSim, READER_RETRY_DELAY_MINUTES),
    reason: "READER_UNAVAILABLE",
    payload,
  });
}

export interface DocumentReadTurnInput {
  readonly operation: Operation;
  /** The event that produced the reading: the intake's, or the timer's (docs/architecture.md §7). */
  readonly upstreamEventId: string;
  readonly atSim: string;
  readonly messageId?: string;
  readonly intakeEventIds?: readonly string[];
}

/** `AGENT_TURN(DOCUMENT_READ)`, its id derived from the event that produced the reading. */
export function documentReadTurn(input: DocumentReadTurnInput): AgentTurnEvent {
  return AgentTurnEvent.parse({
    type: "AGENT_TURN",
    eventId: turnEventId("DOCUMENT_READ", input.upstreamEventId),
    operationId: input.operation.operationId,
    clockId: input.operation.clockId,
    firmId: input.operation.firmId,
    eventAtSim: input.atSim,
    trigger: "DOCUMENT_READ",
    intakeEventIds: [...(input.intakeEventIds ?? [])],
    ...(input.messageId === undefined || !MessageId.safeParse(input.messageId).success ? {} : { messageId: input.messageId }),
  });
}

export const RetryReadingInput = z.object({ operationId: OperationId, payload: ReaderRetryPayload, eventId: z.string().min(1).max(128), atSim: z.string().min(1) }).strict();
export type RetryReadingInput = z.infer<typeof RetryReadingInput>;

export type RetryOutcome = { readonly kind: "SKIPPED"; readonly reason: "VERSION_NOT_PENDING" | "OPERATION_GONE" } | ReadResult;

/** What `fire_timer` runs for a due `TIMER#READER_RETRY`; idempotent once the version is read. */
export async function retryReading(deps: IntakeDeps, raw: RetryReadingInput): Promise<RetryOutcome> {
  const input = RetryReadingInput.parse(raw);
  const operation = await deps.connector.operations.findOperation(input.operationId);
  if (operation === undefined) return { kind: "SKIPPED", reason: "OPERATION_GONE" };
  const version = await pendingVersion(deps.connector, input.payload.docVersionId);
  if (version === undefined || version.operationId !== operation.operationId) return { kind: "SKIPPED", reason: "VERSION_NOT_PENDING" };
  const result = await readPendingVersion(deps, operation, version, input.atSim);
  if (result.kind === "UNAVAILABLE") {
    await scheduleReaderRetry(deps.timers, operation, version, result.failures, input.atSim);
    return result;
  }
  await deps.events.enqueue(documentReadTurn({ operation, upstreamEventId: input.eventId, atSim: input.atSim }));
  return result;
}

/** The `READER_RETRY` action of `fire_timer`: the timer's payload names the version to read again. */
export function readerRetryAction(deps: IntakeDeps): TimerAction {
  return async ({ timer, firing }) => {
    const payload = ReaderRetryPayload.safeParse(timer.payload);
    if (!payload.success) return { outcome: "SKIPPED", reason: "PAYLOAD_INVALID" };
    const eventId = firing.eventId ?? timerEventId(firing.operationId, firing.timerKey, firing.dueAtSim, firing.version);
    const outcome = await retryReading(deps, { operationId: timer.operationId, payload: payload.data, eventId, atSim: firing.eventAtSim });
    if (outcome.kind === "SKIPPED") return { outcome: "SKIPPED", reason: outcome.reason };
    return { outcome: "FIRED", detail: { reading: outcome.kind, docVersionId: outcome.version.docVersionId } };
  };
}
