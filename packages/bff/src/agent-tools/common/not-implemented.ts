// The implementation every tool has until its work package lands (docs/build-plan.md §4: the
// `agent-tools/<target>/handler.ts` of WP-22 pass to WP-25, WP-26 and WP-27 in wave 3). It answers
// `UNAVAILABLE`, which the model treats like any temporary failure: it does not insist, and a turn that
// needs the tool escalates. Every guard of the wrapper still runs before it, so session, scope, trigger
// and strict input are enforced from wave 2 on.
import { fail } from "@legajo/shared";
import type { ToolImplementation } from "./context";

/** The work packages that own the real implementations. */
export type ToolOwner = "WP-25" | "WP-26" | "WP-27";

export function notYetImplemented<I>(owner: ToolOwner): ToolImplementation<I> {
  return async (ctx) => {
    ctx.log.warn("tool.not_implemented", { owner });
    return fail("UNAVAILABLE", "this tool is not available yet; if the turn needs it, escalate to the broker");
  };
}
