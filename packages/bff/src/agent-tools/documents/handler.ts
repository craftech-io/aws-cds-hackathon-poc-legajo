// Implementations of the `documents` tools behind `createToolHandler`. WP-26 owns this file from wave 3
// (docs/build-plan.md §4) and replaces each entry with the real tool; until then every one answers
// `UNAVAILABLE` after the wrapper's session, scope, trigger and strict-input checks.
import type { Implementations } from "../common/context";
import { notYetImplemented } from "../common/not-implemented";
import type { DOCUMENTS_TOOLS } from "./schema";

export const documentsImplementations: Implementations<typeof DOCUMENTS_TOOLS> = {
  read_document: notYetImplemented("WP-26"),
  create_upload_link: notYetImplemented("WP-26"),
};
