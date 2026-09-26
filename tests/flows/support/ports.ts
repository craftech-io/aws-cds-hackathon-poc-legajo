// Seams of the local flows (docs/test-plan.md §2, level LF) towards modules other work packages own.
// The world drives the stage's own code through them: the Gateway targets (`createToolHandler` and
// the five `agent-tools/<target>/handler.ts`), the channel and feed entries, the schedule dispatch,
// the clock and the `OperationWorker`. Until the module that owns a seam exists, its default answers
// `NotWiredError` naming the owner instead of imitating it: a local flow never takes a shortcut around
// policy, Cedar, the pipeline or the worker, so a flow that needs a missing module stays `it.todo`.
import type { GatewayToolName, ToolTarget } from "@legajo/shared";

export class NotWiredError extends Error {
  override readonly name = "NotWiredError";
  constructor(
    readonly seam: string,
    readonly owner: string,
  ) {
    super(`${seam} is not wired into the local flows yet: it drives ${owner}`);
  }
}

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

export const TARGETS_OWNER = "packages/bff/src/agent-tools/<target>/handler.ts through createToolHandler (WP-22, WP-25, WP-26, WP-27)";

export function unwiredTargets(): ToolTargetsPort {
  return { invoke: (call) => Promise.reject(new NotWiredError(`Gateway target ${call.action}`, TARGETS_OWNER)) };
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
 * run, fed with the event shapes AWS delivers, and the worker over the in-process FIFO.
 */
export interface FlowEntries {
  /** `InboundWhatsApp` with an SNS envelope (live) or the phone simulator's signed envelope. */
  inboundWhatsApp(event: unknown): Promise<void>;
  /** `InboundEmail` with the SES receipt; the MIME is already in the in-process mail bucket. */
  inboundEmail(event: unknown): Promise<void>;
  /** `FeedEvents` with an EventBridge event of the `Feeds` bus. */
  feedEvent(event: unknown): Promise<void>;
  /** `ScheduleDispatch` with the input of a schedule. */
  timerFire(input: TimerFire): Promise<void>;
  /** `advance_clock` of a paused world: dispatches what fell due in `dueAtSim` order. */
  advanceClock(clockId: string, move: ClockMove): Promise<void>;
  /** Runs the `OperationWorker` over the in-process FIFO until it is empty; answers the events processed. */
  drain(): Promise<number>;
}

const ENTRY_OWNERS: Readonly<Record<keyof FlowEntries, string>> = {
  inboundWhatsApp: "packages/bff/src/handlers/inbound-whatsapp.ts (WP-29) over channels/whatsapp (WP-20)",
  inboundEmail: "packages/bff/src/handlers/inbound-email.ts (WP-29) over channels/email (WP-19)",
  feedEvent: "packages/bff/src/handlers/feed-events.ts and feeds/ (WP-29)",
  timerFire: "packages/bff/src/handlers/schedule-dispatch.ts (WP-29) over timers/ (WP-27)",
  advanceClock: "packages/bff/src/clock/ (WP-27)",
  drain: "packages/bff/src/handlers/operation-worker.ts and worker/ (WP-28)",
};

export function unwiredEntries(): FlowEntries {
  const off = (entry: keyof FlowEntries) => () => Promise.reject(new NotWiredError(entry, ENTRY_OWNERS[entry]));
  return {
    inboundWhatsApp: off("inboundWhatsApp"),
    inboundEmail: off("inboundEmail"),
    feedEvent: off("feedEvent"),
    timerFire: off("timerFire"),
    advanceClock: off("advanceClock"),
    drain: off("drain"),
  };
}
