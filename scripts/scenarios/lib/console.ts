// The console's procedures as the scenarios call them through the `QaDriver` (`console.*`, the real
// `appRouter` with a firm-qa principal built on the server), typed from the router itself so a changed
// procedure breaks the scenario at compile time instead of in the stage.
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@legajo/bff/routers/index";
import type { ScenarioContext } from "./steps";

export type ConsoleOutputs = inferRouterOutputs<AppRouter>;
export type ConsoleInputs = inferRouterInputs<AppRouter>;

type Router = Exclude<keyof ConsoleOutputs & string, "health">;

export interface ConsoleCallOptions {
  readonly role?: "BROKER" | "ANALYST";
  /** How long ago the principal signed in (recent-login procedures refuse past 15 minutes). */
  readonly authTimeAgoSec?: number;
}

/** A procedure of the console as `brk-qa-runner` (or `brk-qa-analyst`). */
export async function consoleQuery<R extends Router, P extends keyof ConsoleOutputs[R] & string>(
  ctx: ScenarioContext,
  router: R,
  procedure: P,
  input: ConsoleInputs[R][P],
  options: ConsoleCallOptions = {},
): Promise<ConsoleOutputs[R][P]> {
  return (await ctx.qa("console", { procedure: `${router}.${procedure}`, input, ...options })) as ConsoleOutputs[R][P];
}
