// What the `OperationWorker` runs for each event type (docs/architecture.md §7). The agent turn, the
// health probe, the poison event and the deterministic escalation are the worker's own (turns/, this
// folder); the rest are the deterministic handlers of their modules, imported in process (no Gateway,
// `caller WORKER`, docs/tool-catalog.md "Handlers de invocación directa") and wired by the Lambda entry
// (handlers/operation-worker.ts):
//
//   INTAKE_DOCUMENT  `intake_document`            intake/ (WP-26)
//   TIMER            `fire_timer`                 timers/ and milestones/ (WP-27)
//   ETA_CHANGED      `reschedule_on_eta_change`   milestones/ (WP-27)
//   DISPATCH_STATUS  `notify_dispatch_status`     feeds/ (WP-29)
//   EMAIL_EVENT      `apply_email_event`          services/ (WP-43)
//   OUTBOUND_SEND    the outbound pipeline         outbound/ (WP-25)
//   MILESTONE fallback of a failed `DOCS_REQUEST` turn (FL-097)   milestones/ (WP-27)
//
// A handler throws to put the event back on the queue; whatever it enqueues goes through `ctx.sink`, so
// the follow-up is in flight before the current event leaves it.
import type { EscalationReason } from "@legajo/shared";
import type { Logger } from "../lib/log";
import type { DispatchStatusEvent, EmailEventEvent, EtaChangedEvent, IntakeDocumentEvent, OutboundSendEvent, TimerEvent, TurnEvent } from "./events";
import type { OperationEventSink } from "./sink";

export interface WorkerContext {
  readonly log: Logger;
  /** Producer of follow-up events (`AGENT_TURN` after an intake, `TIMER` of a milestone…). */
  readonly sink: OperationEventSink;
  /** Real time; the simulated "now" of every rule is the event's `eventAtSim` or the world's clock. */
  readonly now: () => Date;
  /** `ApproximateReceiveCount` of the delivery (1 on the first one). */
  readonly receiveCount: number;
}

/** Why a `MILESTONE DOCS_REQUEST` turn did not do its job: the deterministic fallback runs instead. */
export type TurnFailureCause = "HARNESS_ERROR" | "TIMEOUT" | "GUARDRAIL" | "INCOMPLETE";

export interface MilestoneFallbackInput {
  readonly event: TurnEvent;
  /** The failed turn (its tool results are in `Runtime/TURN#`), when one was opened. */
  readonly turnId?: string;
  readonly cause: TurnFailureCause;
}

export interface EventHandlers {
  intakeDocument(event: IntakeDocumentEvent, ctx: WorkerContext): Promise<void>;
  fireTimer(event: TimerEvent, ctx: WorkerContext): Promise<void>;
  rescheduleOnEtaChange(event: EtaChangedEvent, ctx: WorkerContext): Promise<void>;
  notifyDispatchStatus(event: DispatchStatusEvent, ctx: WorkerContext): Promise<void>;
  applyEmailEvent(event: EmailEventEvent, ctx: WorkerContext): Promise<void>;
  /** The outbound pipeline with the event's author (the firm, or `SYSTEM` for the worker's fixed reply). */
  outboundSend(event: OutboundSendEvent, ctx: WorkerContext): Promise<void>;
  /** FL-097: `legajo_docs_pendientes` with the parameters of the tools and `AGENT_FALLBACK`. */
  milestoneFallback(input: MilestoneFallbackInput, ctx: WorkerContext): Promise<void>;
}

export interface EscalationRequest {
  readonly operationId: string;
  readonly firmId: string;
  /** The event the escalation belongs to (`caller.eventId`). */
  readonly eventId: string;
  readonly reason: EscalationReason;
  /** At most 500 characters, without personal data (a fixed text of copy/). */
  readonly summary: string;
}

/** `escalate_to_broker` with `caller WORKER`: one open escalation per reason and operation. */
export interface EscalationPort {
  escalate(request: EscalationRequest): Promise<{ readonly escalationId: string }>;
}
