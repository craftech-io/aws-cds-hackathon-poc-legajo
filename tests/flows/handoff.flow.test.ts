// Local flows of the handoff to the firm (docs/flows-catalog.md, areas E and H): the importer asks for
// a person, the deterministic ETA−48 h escalation with its labelled risk, and the firm handing the
// conversation back to the agent. The firm's mailbox is the demo mailbox the escalations write to.
import { describe, it } from "vitest";
import { NEEDS } from "./support/pending";

describe("handoff flows", () => {
  it.todo(
    `[FL-048:pending] "Quiero hablar con Diego" (or TALK_TO_FIRM): plan escalate_to_broker(IMPORTER_ASKED, notifyImporter true) → legajo_escalado to the importer and a MailboxMessage in the firm's mailbox; escalation open — needs ${NEEDS.whatsapp}; ${NEEDS.tools}; ${NEEDS.pipeline}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-066:pending] ESCALATION milestone of op-4478 (NEVER supplier) with documents missing: deterministic Escalation MISSING_AT_ETA_48H with attempts and who owes what, MailboxMessage with "supuesto" from avisos@ (never deferred), ESCALATION_NOTICE to the importer under CP-HOURS-AR — needs ${NEEDS.timers}; ${NEEDS.tools}; ${NEEDS.pipeline}`,
  );
  it.todo(
    `[FL-070:pending] "Devolver al agente" after the firm wrote: release_conversation → control AGENT → turn BROKER_RELEASED whose envelope refers to the firm's messages; no second DOCS_REQUEST of the same day — needs ${NEEDS.consoleRouters}; ${NEEDS.services}; ${NEEDS.worker}; ${NEEDS.pipeline}`,
  );
});
