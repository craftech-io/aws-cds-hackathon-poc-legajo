// Implementations of the `operations` tools behind `createToolHandler`. WP-26 owns this file from wave 3
// (docs/build-plan.md §4) and replaces each entry with the real tool; until then every one answers
// `UNAVAILABLE` after the wrapper's session, scope, trigger and strict-input checks.
import type { Implementations } from "../common/context";
import { notYetImplemented } from "../common/not-implemented";
import type { OPERATIONS_TOOLS } from "./schema";

export const operationsImplementations: Implementations<typeof OPERATIONS_TOOLS> = {
  get_operation: notYetImplemented("WP-26"),
  get_dossier: notYetImplemented("WP-26"),
  assign_responsible: notYetImplemented("WP-26"),
  get_counterpart_profile: notYetImplemented("WP-26"),
  get_checklist: notYetImplemented("WP-26"),
  get_dispatch_status: notYetImplemented("WP-26"),
};
