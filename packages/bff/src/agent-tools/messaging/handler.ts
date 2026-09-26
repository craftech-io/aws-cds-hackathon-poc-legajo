// Implementations of the `messaging` tools behind `createToolHandler`. WP-25 owns this file from wave 3
// (docs/build-plan.md §4) and replaces each entry with the real tool; until then every one answers
// `UNAVAILABLE` after the wrapper's session, scope, trigger and strict-input checks.
import type { Implementations } from "../common/context";
import { notYetImplemented } from "../common/not-implemented";
import type { MESSAGING_TOOLS } from "./schema";

export const messagingImplementations: Implementations<typeof MESSAGING_TOOLS> = {
  send_whatsapp: notYetImplemented("WP-25"),
  send_email: notYetImplemented("WP-25"),
  propose_supplier_contact: notYetImplemented("WP-25"),
};
