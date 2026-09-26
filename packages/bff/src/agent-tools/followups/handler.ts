// Implementations of the `followups` tools behind `createToolHandler`. WP-27 owns this file from wave 3
// (docs/build-plan.md §4) and replaces each entry with the real tool; until then every one answers
// `UNAVAILABLE` after the wrapper's session, scope, trigger and strict-input checks.
import type { Implementations } from "../common/context";
import { notYetImplemented } from "../common/not-implemented";
import type { FOLLOWUPS_TOOLS } from "./schema";

export const followupsImplementations: Implementations<typeof FOLLOWUPS_TOOLS> = {
  schedule_followup: notYetImplemented("WP-27"),
  estimate_delay_risk: notYetImplemented("WP-27"),
};
