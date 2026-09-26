// Local flows of the importer's questions (docs/flows-catalog.md, area E): what is missing, answers
// grounded on the checklist, questions it does not cover, denied topics, an unrelated topic, the delay
// risk with its labelled assumptions and the meaning of a customs channel. The G1 pre-filter and G2
// answer from the guardrail script of the AWS fakes; the assertions follow the oracles of
// docs/test-plan.md §4.3 (state and structure, never the wording).
import { describe, it } from "vitest";
import { NEEDS } from "./support/pending";

describe("importer question flows", () => {
  it.todo(
    `[FL-020:pending] "¿Qué me falta?": turn IMPORTER_MESSAGE, plan get_dossier → send_whatsapp(REPLY) with refs.docTypes = the missing documents; G2 passes, deterministic verification finds every date in the turn results — needs ${NEEDS.whatsapp}; ${NEEDS.worker}; ${NEEDS.pipeline}; ${NEEDS.tools}`,
  );
  it.todo(
    `[FL-045:pending] QUESTION button then "¿El certificado tiene que estar firmado?": plan get_checklist(CERTIFICATE_OF_ORIGIN) → send_whatsapp(REPLY); guardrail.groundingScore ≥ 0.75 and the item CO-02 in Runtime/TURN# — needs ${NEEDS.whatsapp}; ${NEEDS.tools}; ${NEEDS.pipeline}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-046:pending] "¿Necesito también el BL original?": get_checklist without an item → send_whatsapp(REPLY) deferring to the firm → escalate_to_broker(OUT_OF_CHECKLIST); exactly one open escalation and no statement about the BL in the outgoing text — needs ${NEEDS.tools}; ${NEEDS.pipeline}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-047:pending] the five denied topics with the G1 pre-filter scripted BLOCKED on topics: no Harness call, fixed refusal REPLY with author SYSTEM, escalate_to_broker(OUT_OF_CHECKLIST) direct, AuditLog GUARDRAIL_BLOCK origin PREFILTER source IMPORTER; exactly one open OUT_OF_CHECKLIST after the five; the next milestone of the operation runs a normal turn — needs ${NEEDS.worker}; ${NEEDS.pipeline}; ${NEEDS.tools}; ${NEEDS.timers}`,
  );
  it.todo(
    `[FL-049:pending] "¿Viste el partido?": plan send_whatsapp(REPLY) back to the operation; one REPLY, no escalation, refs.operationId of the operation — needs ${NEEDS.whatsapp}; ${NEEDS.worker}; ${NEEDS.pipeline}`,
  );
  it.todo(
    `[FL-052:pending] "¿Cuánto me sale si se atrasa?": plan estimate_delay_risk → send_whatsapp(REPLY) with the word "supuesto" and only figures present in the tool result — needs ${NEEDS.tools}; ${NEEDS.pipeline}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-053:pending] "¿Qué significa canal naranja?": plan get_dispatch_status → send_whatsapp(REPLY) grounded on genericExplanation (grounding ≥ 0.75), no recommendation — needs ${NEEDS.tools}; ${NEEDS.pipeline}; ${NEEDS.worker}`,
  );
});
