// Local flows of the importer on WhatsApp (docs/flows-catalog.md, areas A and B): opt-in, the
// DOCS_REQUEST template, delegating to the supplier, opting out, a PDF by WhatsApp and the choice
// between two open operations. Each runs on the in-process world (support/world.ts): the importer
// writes through `InboundWhatsApp` with the simulator's envelope, milestones fire through the clock,
// the worker hands the envelope to the scripted Harness and every send goes through the outbound
// pipeline to the recording WhatsApp transport.
import { describe, it } from "vitest";
import { NEEDS } from "./support/pending";

describe("importer flows on WhatsApp", () => {
  it.todo(
    `[FL-002:pending] op-4473 (importer without opt-in), DOCS_REQUEST milestone: plan get_dossier → send_whatsapp(DOCS_REQUEST) answers POLICY_DENIED CP-OPTIN → escalate_to_broker(OTHER); no outgoing WhatsApp, AuditLog DENY CP-OPTIN, one open escalation in escalations.list — needs ${NEEDS.seed}; ${NEEDS.timers}; ${NEEDS.worker}; ${NEEDS.policy}; ${NEEDS.pipeline}`,
  );
  it.todo(
    `[FL-007:pending] op-4471 DOCS_REQUEST milestone at 15/10 10:00: plan get_operation, get_dossier, get_counterpart_profile(IMPORTER), send_whatsapp(template legajo_docs_pendientes); Message OUT DOCS_REQUEST with the template, 3 nonces and the upload link, DOC# requestedFrom IMPORTER, TIMER#MILESTONE#DOCS_REQUEST FIRED — needs ${NEEDS.timers}; ${NEEDS.worker}; ${NEEDS.pipeline}; ${NEEDS.tools}`,
  );
  it.todo(
    `[FL-011:pending] SUPPLIER_SENDS button (nonce of FL-007) with the supplier authorised: InboundWhatsApp resolves the nonce, turn IMPORTER_MESSAGE, plan get_counterpart_profile(SUPPLIER) → send_whatsapp(CONTACT_CONFIRMATION); Message IN button and Message OUT CONTACT_CONFIRMATION with 3 nonces — needs ${NEEDS.whatsapp}; ${NEEDS.worker}; ${NEEDS.pipeline}; ${NEEDS.services}`,
  );
  it.todo(
    `[FL-016:pending] OPT_OUT button and the exact keyword BAJA: revoke_consent without a turn, OPT_OUT_CONFIRMATION (fixed text), Escalation OPTED_OUT; the next milestone of the operation gets DENY CP-OPTOUT — needs ${NEEDS.whatsapp}; ${NEEDS.services}; ${NEEDS.policy}; ${NEEDS.timers}`,
  );
  it.todo(
    `[FL-017:pending] packing list PDF from the phone simulator (sim-media): INTAKE_DOCUMENT → in-process reader → DocumentVersion source.channel WHATSAPP, DOC#PACKING_LIST VALID; turn DOCUMENT_READ with plan send_whatsapp(REPLY) — needs ${NEEDS.whatsapp}; ${NEEDS.intake}; ${NEEDS.seed}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-019:pending] importer with two open operations (op-4474 and op-4475 share the importer) writes free text: deterministic OPERATION_CHOICE, no turn until the choice; the choice enqueues one turn on the chosen operation with the original text — needs ${NEEDS.whatsapp}; ${NEEDS.seed}; ${NEEDS.worker}`,
  );
});
