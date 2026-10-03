// The scripted Harness of the local flows (docs/test-plan.md §2, level LF): instead of a model, a
// fixed plan of Gateway tool calls written in the test. It receives the envelope the caller built,
// reads the `sessionToken` and the event from it (envelope.ts), and runs each call of the plan through
// the local Gateway (gateway.ts: the stage's Cedar statements, then the target Lambdas). Everything
// around the plan is the stage's code; only the choice of calls is scripted.
//
// `invoke` answers `InvokeHarnessCommand` the way the SDK does (a stream of `messageStart`, tool use
// and tool result blocks, the final text, `messageStop` and `metadata`), so the Harness client of the
// worker reads a scripted turn exactly like a real one. The final text is the turn note (ADR-0011).
import type { HarnessStopReason, InvokeHarnessCommandInput, InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import type { GatewayToolName, TurnTrigger } from "@legajo/shared";
import { readEnvelope, type ReadEnvelope } from "./envelope";
import type { GatewayCall, LocalGateway } from "./gateway";

export interface PlanContext {
  readonly envelope: ReadEnvelope;
  /** Calls already made in this turn, in order (their outputs feed later inputs). */
  readonly calls: readonly GatewayCall[];
}

export type PlanInput = Readonly<Record<string, unknown>> | ((context: PlanContext) => Readonly<Record<string, unknown>>);

export interface PlanStep {
  readonly tool: GatewayToolName;
  /** Arguments as the model would write them; `sessionToken` is added from the envelope. */
  readonly input: PlanInput;
  /** The model leaves the token out (the `CED-SESSION-*` forbids fence it). */
  readonly withoutSessionToken?: boolean;
  /** The model makes this call only when what it read earlier in the turn says so. */
  readonly when?: (context: PlanContext) => boolean;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
}

export interface Plan {
  readonly steps: readonly PlanStep[];
  /** Final text of the turn: an internal note, never a message to anyone. */
  readonly note: string;
  readonly stopReason?: HarnessStopReason;
  readonly usage?: Partial<TokenUsage>;
}

/** Chooses the plan of a turn from its envelope; throws when the test did not script that turn. */
export type PlanSource = (envelope: ReadEnvelope) => Plan;

export interface HarnessInvocation {
  /** The user message of the invocation: the envelope. */
  readonly text: string;
  readonly runtimeSessionId?: string;
  readonly actorId?: string;
}

export interface ScriptedTurn {
  readonly invocation: HarnessInvocation;
  readonly envelope: ReadEnvelope;
  readonly calls: readonly GatewayCall[];
  readonly note: string;
  readonly stopReason: HarnessStopReason;
  readonly usage: TokenUsage;
}

export interface ScriptedHarness {
  /** Every turn run so far, in order. */
  readonly turns: readonly ScriptedTurn[];
  run(invocation: HarnessInvocation): Promise<ScriptedTurn>;
  /** `InvokeHarnessCommand`, answered like the SDK: the turn runs, then its stream is returned. */
  invoke(input: InvokeHarnessCommandInput): Promise<{ readonly stream: AsyncIterable<InvokeHarnessStreamOutput> }>;
}

/** Usage of a scripted turn unless its plan says otherwise (the scripted agent spends no model tokens). */
export const SCRIPTED_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };

/** One plan per turn, in the order the turns happen. */
export function planQueue(plans: readonly Plan[]): PlanSource {
  const pending = [...plans];
  return (envelope) => {
    const next = pending.shift();
    if (next === undefined) throw new Error(`no scripted plan left for the ${envelope.event.type} turn of ${envelope.event.operation}`);
    return next;
  };
}

/** The plans of each trigger, consumed in order; a trigger without plans left throws. */
export function plansByTrigger(plans: Partial<Record<TurnTrigger, readonly Plan[]>>): PlanSource {
  const queues = new Map(Object.entries(plans).map(([trigger, list]) => [trigger, planQueue(list ?? [])] as const));
  return (envelope) => {
    const queue = queues.get(envelope.event.type);
    if (queue === undefined) throw new Error(`no scripted plan for a ${envelope.event.type} turn`);
    return queue(envelope);
  };
}

/** A turn the test did not script: the agent reads nothing and writes no message (a note only). */
export const QUIET_PLAN: Plan = { steps: [], note: "Nada que hacer en este turno." };

/**
 * Plans per operation number and trigger, consumed in order. A turn of any other operation, or one
 * whose queue ran out, gets `otherwise` (quiet by default): the world's other operations keep living
 * while a test follows one of them.
 */
export function plansByOperation(plans: Readonly<Record<string, Partial<Record<TurnTrigger, readonly Plan[]>>>>, otherwise: PlanSource = () => QUIET_PLAN): PlanSource {
  const queues = new Map<string, Plan[]>();
  for (const [operation, byTrigger] of Object.entries(plans)) for (const [trigger, list] of Object.entries(byTrigger)) queues.set(`${operation}#${trigger}`, [...(list ?? [])]);
  return (envelope) => queues.get(`${envelope.event.operation}#${envelope.event.type}`)?.shift() ?? otherwise(envelope);
}

/** The text of the last user message of an `InvokeHarness` request. */
export function invocationText(input: Pick<InvokeHarnessCommandInput, "messages">): string {
  const user = [...(input.messages ?? [])].reverse().find((message) => message.role === "user");
  const text = (user?.content ?? []).flatMap((block) => (typeof block.text === "string" ? [block.text] : [])).join("\n");
  if (text === "") throw new Error("InvokeHarness without a user message");
  return text;
}

function resolveInput(step: PlanStep, context: PlanContext): Record<string, unknown> {
  const written = typeof step.input === "function" ? step.input(context) : step.input;
  return step.withoutSessionToken ? { ...written } : { ...written, sessionToken: context.envelope.sessionToken };
}

function toolUseId(turn: number, call: number): string {
  return `tooluse_${turn}_${call}`;
}

/** The stream `InvokeHarness` would have produced for a turn. */
export async function* harnessStream(turn: ScriptedTurn, turnIndex: number): AsyncGenerator<InvokeHarnessStreamOutput> {
  yield { messageStart: { role: "assistant" } };
  let block = 0;
  for (const [index, call] of turn.calls.entries()) {
    const id = toolUseId(turnIndex, index);
    yield { contentBlockStart: { contentBlockIndex: block, start: { toolUse: { toolUseId: id, name: call.action } } } };
    yield { contentBlockDelta: { contentBlockIndex: block, delta: { toolUse: { input: JSON.stringify(call.input) } } } };
    yield { contentBlockStop: { contentBlockIndex: block } };
    block += 1;
    const denied = call.cedar.decision === "DENY";
    yield { contentBlockStart: { contentBlockIndex: block, start: { toolResult: { toolUseId: id, status: denied ? "error" : "success" } } } };
    const result = denied ? { error: "AccessDeniedException", policies: call.cedar.determining } : (call.output ?? null);
    yield { contentBlockDelta: { contentBlockIndex: block, delta: { toolResult: [{ text: JSON.stringify(result) }] } } };
    yield { contentBlockStop: { contentBlockIndex: block } };
    block += 1;
  }
  yield { contentBlockDelta: { contentBlockIndex: block, delta: { text: turn.note } } };
  yield { contentBlockStop: { contentBlockIndex: block } };
  yield { messageStop: { stopReason: turn.stopReason } };
  yield {
    metadata: {
      usage: { ...turn.usage, totalTokens: turn.usage.inputTokens + turn.usage.outputTokens },
      metrics: { latencyMs: 0 },
    },
  };
}

export function createScriptedHarness(options: { readonly gateway: LocalGateway; readonly plans: PlanSource }): ScriptedHarness {
  const turns: ScriptedTurn[] = [];

  async function run(invocation: HarnessInvocation): Promise<ScriptedTurn> {
    const envelope = readEnvelope(invocation.text);
    const plan = options.plans(envelope);
    const calls: GatewayCall[] = [];
    for (const step of plan.steps) {
      if (step.when !== undefined && !step.when({ envelope, calls })) continue;
      calls.push(await options.gateway.call(step.tool, resolveInput(step, { envelope, calls })));
    }
    const turn: ScriptedTurn = {
      invocation,
      envelope,
      calls,
      note: plan.note,
      stopReason: plan.stopReason ?? "end_turn",
      usage: { ...SCRIPTED_USAGE, ...plan.usage },
    };
    turns.push(turn);
    return turn;
  }

  return {
    turns,
    run,
    async invoke(input) {
      const turn = await run({
        text: invocationText(input),
        ...(input.runtimeSessionId === undefined ? {} : { runtimeSessionId: input.runtimeSessionId }),
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      });
      return { stream: harnessStream(turn, turns.length - 1) };
    },
  };
}
