// Scenarios, steps and the context a step runs with (docs/test-plan.md §4). Every step declares the
// flows it proves (`flows: ["FL-xxx", …]`, what `npm run flows:check` looks for) and talks to the stage
// only through the `QaDriver`. The context enforces the rules of §4.3 and §4.4:
//
//   - every call carries `<runId>/<scenario>/<step>/<label>`; changing calls are labelled `m1`, `m2`…
//     in order and reads `r1`, `r2`…, so a step re-run under the same run id replays its effects;
//   - a negative ("none") or an exact count ("exactly") is only asserted on a snapshot taken by
//     `settled()` after the last changing call: anything else is an error of the scenario itself;
//   - a discard is proven by its reason (`mail.outcome`), never by the absence of effects alone.
import { READ_ONLY_ACTIONS, type QaActionName, type QaResponse, idempotencyKeyOf } from "@legajo/bff/qa-driver/contract";
import type { QaInput } from "@legajo/bff/qa-driver/contract-inputs";
import type { QaSnapshot } from "@legajo/bff/qa-driver/snapshot";
import { type ConsoleAction, checkedConsoleAction } from "./console";
import type { DriverClient } from "./driver-client";
import { WAITS, eventually } from "./eventually";

export type Suite = "smoke" | "full";

/** An action's input as a scenario writes it: the `console` action typed per procedure (lib/console.ts). */
export type ScenarioQaInput<A extends QaActionName> = A extends "console" ? ConsoleAction : QaInput<A>;
export type BlockOrigin = "PREFILTER" | "HARNESS_G1" | "CEDAR" | "LAMBDA_FENCE" | "OUTBOUND_VERIFY" | "MODEL_REFUSAL" | "NONE";

export interface StepDef {
  /** The number the flows catalog cites (`SC-01/2` is step 2); 0 for setup without flows. */
  readonly n: number;
  readonly title: string;
  readonly flows: readonly string[];
  readonly run: (ctx: ScenarioContext) => Promise<void>;
}

export interface ScenarioDef {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly suites: readonly Suite[];
  /** Scenarios of one lane run one after the other (`guest`: SC-25 then SC-24, one account). */
  readonly lane?: string;
  /** Runs alone after every other scenario (SC-20 reads their reports). */
  readonly last?: boolean;
  readonly steps: readonly StepDef[];
  /** Always runs, also after a failure (`world.destroy`, `dlq.delete`, a final reset). */
  readonly cleanup?: (ctx: ScenarioContext) => Promise<void>;
}

export function defineScenario(scenario: ScenarioDef): ScenarioDef {
  const numbers = scenario.steps.map((step) => step.n);
  if (new Set(numbers).size !== numbers.length) throw new RangeError(`${scenario.id} repeats a step number`);
  return scenario;
}

/** The driver refused or failed: code and reason as it answered them. */
export class DriverRefusal extends Error {
  override readonly name = "DriverRefusal";
  constructor(
    readonly action: QaActionName,
    readonly code: string,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(`${action}: ${code}${reason === undefined ? "" : `/${reason}`} ${message}`);
  }
}

export class ScenarioBug extends Error {
  override readonly name = "ScenarioBug";
}

export class AssertionFailed extends Error {
  override readonly name = "AssertionFailed";
}

/** An assertion that also narrows the type (the context's `check` cannot, being a method of a contextually typed parameter). */
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionFailed(message);
}

export interface StepRecord {
  readonly ids: Record<string, string>;
  readonly blocks: Array<{ readonly origin: BlockOrigin; readonly detail: string }>;
  readonly warnings: string[];
}

export interface ScenarioContext {
  readonly runId: string;
  readonly scenario: ScenarioDef;
  readonly step: number;
  /** Values steps pass to later steps (ids of the world, mail ids, baselines). */
  readonly state: Record<string, unknown>;
  /** Results of the scenarios that ran before (SC-20 aggregates their policy audits). */
  readonly previous: readonly { readonly scenario: string; readonly violations: number; readonly unaudited: number }[];
  qa<A extends QaActionName>(action: A, input: ScenarioQaInput<A>): Promise<any>;
  /** Idempotency key of the last call of this step (a later step may replay a platform event with it). */
  lastKey(): string | undefined;
  /** The driver's answer as it is, for an expected refusal. */
  attempt<A extends QaActionName>(action: A, input: ScenarioQaInput<A>): Promise<QaResponse<any>>;
  snapshot(operationId: string): Promise<QaSnapshot>;
  /** `op.settle` and a snapshot: the only snapshot negatives and exact counts accept. */
  settled(operationId: string, timeoutSec?: number): Promise<QaSnapshot>;
  eventually<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutSec: number, everySec?: number): Promise<T>;
  /**
   * A fixed real wait, only before settling after something no pending tracks in transit (an event
   * of the `Feeds` bus on its way to `FeedEvents`), so a negative does not pass before it arrives.
   */
  pause(seconds: number): Promise<void>;
  check(condition: unknown, message: string): void;
  none<T>(snapshot: QaSnapshot, what: string, items: readonly T[]): void;
  exactly<T>(snapshot: QaSnapshot, count: number, what: string, items: readonly T[]): T[];
  blocked(origin: BlockOrigin, detail: string): void;
  note(name: string, value: string): void;
  warn(message: string): void;
}

function consoleInput(action: ConsoleAction): ConsoleAction {
  try {
    return checkedConsoleAction(action);
  } catch (error) {
    throw new ScenarioBug(`the input of console.${action.procedure} is not the procedure's: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface ContextOptions {
  readonly runId: string;
  readonly scenario: ScenarioDef;
  readonly driver: DriverClient;
  readonly state: Record<string, unknown>;
  readonly previous?: ScenarioContext["previous"];
  readonly waitOptions?: { readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> };
}

/** Context of one step; `record` collects what the report shows for it. */
export function stepContext(options: ContextOptions, step: number, record: StepRecord): ScenarioContext {
  let changes = 0;
  let reads = 0;
  let last: string | undefined;
  // Snapshot → the number of changing calls when it was taken after a settle.
  const settledAt = new WeakMap<object, number>();

  async function call<A extends QaActionName>(action: A, written: ScenarioQaInput<A>): Promise<QaResponse<any>> {
    const input = (action === "console" ? consoleInput(written as ConsoleAction) : written) as QaInput<A>;
    const changing = !READ_ONLY_ACTIONS.has(action) && !(action === "console" && /\.(?:get|list|timeline|summary|violations|decisionsByRule|export|threads)$/.test((input as { procedure?: string }).procedure ?? ""));
    const label = changing ? `m${++changes}` : `r${++reads}`;
    const key = idempotencyKeyOf({ runId: options.runId, scenario: options.scenario.slug, step, label });
    last = key;
    return options.driver.call(action, input, key);
  }

  function requireSettled(snapshot: QaSnapshot, what: string): void {
    const at = settledAt.get(snapshot);
    if (at === undefined || at !== changes) throw new ScenarioBug(`"${what}" is a negative or an exact count: assert it on a snapshot from settled() taken after the last change`);
  }

  const ctx: ScenarioContext = {
    runId: options.runId,
    scenario: options.scenario,
    step,
    state: options.state,
    previous: options.previous ?? [],
    async qa(action, input) {
      const answer = await call(action, input);
      if (!answer.ok) throw new DriverRefusal(action, answer.error.code, answer.error.reason, answer.error.message);
      return answer.result;
    },
    attempt: call,
    lastKey: () => last,
    async snapshot(operationId) {
      return (await ctx.qa("snapshot", { operationId })) as QaSnapshot;
    },
    async settled(operationId, timeoutSec = WAITS.settleSec) {
      await ctx.qa("op.settle", { operationId, timeoutSec });
      const snapshot = await ctx.snapshot(operationId);
      settledAt.set(snapshot, changes);
      return snapshot;
    },
    eventually(what, probe, timeoutSec, everySec) {
      return eventually(what, probe, { timeoutSec, ...(everySec === undefined ? {} : { everySec }), ...options.waitOptions });
    },
    pause(seconds) {
      const sleep = options.waitOptions?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      return sleep(seconds * 1_000);
    },
    check(condition, message) {
      ensure(condition, message);
    },
    none(snapshot, what, items) {
      requireSettled(snapshot, what);
      if (items.length > 0) throw new AssertionFailed(`expected no ${what}, found ${items.length}`);
    },
    exactly(snapshot, count, what, items) {
      requireSettled(snapshot, what);
      if (items.length !== count) throw new AssertionFailed(`expected exactly ${count} ${what}, found ${items.length}`);
      return [...items];
    },
    blocked(origin, detail) {
      record.blocks.push({ origin, detail });
    },
    note(name, value) {
      record.ids[name] = value;
    },
    warn(message) {
      record.warnings.push(message);
    },
  };
  return ctx;
}
