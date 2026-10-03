// Seams of the local flows (docs/test-plan.md §2, level LF): the Gateway targets behind Cedar and the
// entry points of the stage. The world (world.ts) wires both to the stage's own modules
// (stage/context.ts, stage/entries.ts); a test may swap the targets for a recording double when what it
// proves is that nothing reaches them (FL-074).
import type { GatewayToolName, ToolTarget } from "@legajo/shared";

/** One Gateway tool call that Cedar allowed, as the target Lambda receives it. */
export interface ToolInvocation {
  readonly target: ToolTarget;
  readonly tool: GatewayToolName;
  /** `<target>___<tool>`, the name the Gateway and Cedar give the tool. */
  readonly action: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** The Gateway targets behind Cedar: each call runs the target's handler (`createToolHandler`). */
export interface ToolTargetsPort {
  invoke(call: ToolInvocation): Promise<unknown>;
}

export interface RecordingTargets extends ToolTargetsPort {
  readonly calls: ToolInvocation[];
}

/** Records every call that reached a target and answers what `answer` returns (a failure by default). */
export function recordingTargets(answer: (call: ToolInvocation) => unknown = () => ({ ok: false, error: { code: "UNAVAILABLE", message: "recorded, not executed" } })): RecordingTargets {
  const calls: ToolInvocation[] = [];
  return {
    calls,
    invoke(call) {
      calls.push(call);
      return Promise.resolve(answer(call));
    },
  };
}

/** `ScheduleDispatch` input (docs/architecture.md §8). */
export interface TimerFire {
  readonly clockId: string;
  readonly operationId: string;
  readonly timerKey: string;
  readonly dueAtSim: string;
  readonly version: number;
}

export type ClockMove = { readonly byMinutes: number } | { readonly to: string } | { readonly next: true };

/**
 * The entry points of the stage (docs/test-plan.md §3, "Flujos locales"): the same handlers the Lambdas
 * run, fed with the event shapes AWS delivers (each answers what its handler returned), and the worker
 * over the in-process FIFO.
 */
export interface FlowEntries {
  /** `InboundWhatsApp` with an SNS envelope (live) or the phone simulator's signed envelope. */
  inboundWhatsApp(event: unknown): Promise<unknown>;
  /** `InboundEmail` with the SES receipt; the MIME is already in the in-process mail bucket. */
  inboundEmail(event: unknown): Promise<unknown>;
  /** `FeedEvents` with an EventBridge event of the `Feeds` bus. */
  feedEvent(event: unknown): Promise<unknown>;
  /** `ScheduleDispatch` with the input of a schedule. */
  timerFire(input: TimerFire): Promise<unknown>;
  /** `advance_clock` of a paused world: dispatches what fell due in `dueAtSim` order. */
  advanceClock(clockId: string, move: ClockMove): Promise<void>;
  /** Runs the `OperationWorker` over the in-process FIFO until it is empty; answers the events processed. */
  drain(): Promise<number>;
}

