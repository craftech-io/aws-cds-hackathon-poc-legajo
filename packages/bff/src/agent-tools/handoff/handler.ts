// Implementations of the `handoff` tools behind `createToolHandler`. WP-27 owns this file from wave 3
// (docs/build-plan.md §4) and replaces each entry with the real tool; until then every one answers
// `UNAVAILABLE` after the wrapper's session, scope, trigger and strict-input checks.
import type { Implementations } from "../common/context";
import { notYetImplemented } from "../common/not-implemented";
import type { HANDOFF_TOOLS } from "./schema";

export const handoffImplementations: Implementations<typeof HANDOFF_TOOLS> = {
  escalate_to_broker: notYetImplemented("WP-27"),
  request_approval: notYetImplemented("WP-27"),
};
