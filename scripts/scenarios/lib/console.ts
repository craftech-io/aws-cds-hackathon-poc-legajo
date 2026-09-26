// The console's procedures as the scenarios call them through the `QaDriver` (`console.*`, the real
// `appRouter` with a firm-qa principal built on the server), typed from the router itself so a changed
// procedure breaks the scenario at compile time instead of in the stage. A change procedure the
// router does not register yet is typed, and validated before it leaves, by the one schema the
// console and the BFF router share (@legajo/shared console-inputs): the web and the scenarios can
// never disagree on its input.
import type { AnyProcedure, AnyRouter, inferProcedureInput, inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { CONSOLE_CHANGE_INPUTS, type ConsoleChangeInputs, type ConsoleChangePath, isConsoleChangePath } from "@legajo/shared";
import type { AppRouter } from "@legajo/bff/routers/index";
import type { ScenarioContext } from "./steps";

export type ConsoleOutputs = inferRouterOutputs<AppRouter>;
export type ConsoleInputs = inferRouterInputs<AppRouter>;

type Router = Exclude<keyof ConsoleOutputs & string, "health">;

/** Every procedure of a router record by its dotted path, with its input. */
type ProcedureCalls<Record, Prefix extends string = ""> = {
  [K in keyof Record & string]: Record[K] extends AnyProcedure
    ? { readonly path: `${Prefix}${K}`; readonly input: inferProcedureInput<Record[K]> }
    : Record[K] extends AnyRouter
      ? ProcedureCalls<Record[K]["_def"]["record"], `${Prefix}${K}.`>
      : ProcedureCalls<Record[K], `${Prefix}${K}.`>;
}[keyof Record & string];

type RouterCall = ProcedureCalls<AppRouter["_def"]["record"]>;
type RouterPath = RouterCall["path"];

/** Input of every console procedure: the router's when it registers the path, the shared schema's otherwise. */
export type ConsoleProcedureInputs = { readonly [C in RouterCall as C["path"]]: C["input"] } & {
  readonly [P in Exclude<ConsoleChangePath, RouterPath>]: ConsoleChangeInputs[P];
};
export type ConsoleProcedure = keyof ConsoleProcedureInputs & string;

export interface ConsoleCallOptions {
  readonly role?: "BROKER" | "ANALYST";
  /** How long ago the principal signed in (recent-login procedures refuse past 15 minutes). */
  readonly authTimeAgoSec?: number;
}

/** The `console` action's input as the scenarios write it: one procedure with its own input. */
export type ConsoleAction = {
  readonly [P in ConsoleProcedure]: { readonly procedure: P; readonly input?: ConsoleProcedureInputs[P] } & ConsoleCallOptions;
}[ConsoleProcedure];

/**
 * A change procedure's input through its shared schema (a malformed input is the scenario's bug and
 * never reaches the stage); any other procedure's input as it is (the router validates it).
 */
export function checkedConsoleAction(action: ConsoleAction): ConsoleAction {
  if (!isConsoleChangePath(action.procedure)) return action;
  return { ...action, input: CONSOLE_CHANGE_INPUTS[action.procedure].parse(action.input ?? {}) } as ConsoleAction;
}

/** A procedure of the console as `brk-qa-runner` (or `brk-qa-analyst`). */
export async function consoleQuery<R extends Router, P extends keyof ConsoleOutputs[R] & string>(
  ctx: ScenarioContext,
  router: R,
  procedure: P,
  input: ConsoleInputs[R][P],
  options: ConsoleCallOptions = {},
): Promise<ConsoleOutputs[R][P]> {
  const action = { procedure: `${router}.${procedure}`, input, ...options } as unknown as ConsoleAction;
  return (await ctx.qa("console", action)) as ConsoleOutputs[R][P];
}
