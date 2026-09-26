// Local flows after the human approval (docs/flows-catalog.md, area I): the customs status of an
// approved dossier reaches the importer as a fixed template with the glossary's generic explanation,
// and the release closes the operation. The platform mock emits the statuses in process.
import { describe, it } from "vitest";
import { NEEDS } from "./support/pending";

describe("approval and dispatch flows", () => {
  it.todo(
    `[FL-077:pending] CustomsStatusChanged OFICIALIZADO → CANAL_ASIGNADO NARANJA → LIBERADO on op-4487 (approved): notify_dispatch_status sends three DISPATCH_STATUS (template despacho_estado with the generic explanation), META.dispatch follows, LIBERADO closes the operation and cancels its timers; CP-APPROVED-SCOPE allows only these — needs ${NEEDS.feeds}; ${NEEDS.pipeline}; ${NEEDS.timers}`,
  );
});
