// Local flows of the supplier by email (docs/flows-catalog.md, areas B and C): the first request in
// English, contacts proposed by the importer, replies with the right, the wrong or an unknown PDF,
// promises, silence and a permanent bounce. The supplier writes through `InboundEmail` with an SES
// receipt and a MIME in the in-process mail bucket (support/fakes); the reader mock reads each PDF in
// process; the recording SES transport keeps what the pipeline would send.
import { describe, it } from "vitest";
import { NEEDS } from "./support/pending";

describe("supplier flows by email", () => {
  it.todo(
    `[FL-012:pending] CONFIRM_CONTACT on op-4471 at 15/10 10:0x: confirm_supplier_contact → turn CONTACT_CONFIRMED, plan get_dossier → send_email(DOCS_REQUEST, recipientRole SUPPLIER) DEFERRED by CP-HOURS-SUPPLIER to 16/10 09:00 Qingdao → advance → SENT with X-Legajo-Request and subject [Op 4471]; CONTACT# ACTIVE confirmedBy IMPORTER, DOC# requestedFrom SUPPLIER — needs ${NEEDS.services}; ${NEEDS.worker}; ${NEEDS.pipeline}; ${NEEDS.email}; ${NEEDS.timers}`,
  );
  it.todo(
    `[FL-013:pending] SUPPLIER_SENDS on op-4472 without authorisation: send_email → POLICY_DENIED CP-SUPPLIER-AUTH, send_whatsapp(REPLY), escalate_to_broker(OTHER); no email, AuditLog DENY CP-SUPPLIER-AUTH, open escalation — needs ${NEEDS.seed}; ${NEEDS.worker}; ${NEEDS.pipeline}; ${NEEDS.policy}`,
  );
  it.todo(
    `[FL-014:pending] OTHER_CONTACT and a text with the alternative address: propose_supplier_contact(email, sourceMessageId) → contact PENDING_CONFIRMATION and confirmation buttons → CONFIRM_CONTACT → ACTIVE → turn CONTACT_CONFIRMED → send_email to the new contact — needs ${NEEDS.whatsapp}; ${NEEDS.pipeline}; ${NEEDS.services}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-015:pending] proposed address outside the recipient fence (a reserved domain): propose_supplier_contact → RECIPIENT_NOT_ALLOWED, no new contact, AuditLog DENY CP-RECIPIENT-FENCE, escalate_to_broker(OTHER) — needs ${NEEDS.pipeline}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-021:pending] trusted reply of the ACTIVE contact (dmarcVerdict PASS) with packing list and certificate: two intakes → VALID; turn SUPPLIER_EMAIL with plan request_approval → READY_FOR_REVIEW and send_whatsapp to the importer; Message IN EMAIL trusted — needs ${NEEDS.email}; ${NEEDS.intake}; ${NEEDS.simMail}; ${NEEDS.worker}; ${NEEDS.tools}`,
  );
  it.todo(
    `[FL-025:pending] WRONG_DOC: the reader recognises a commercial invoice where the certificate was asked; version filed under the real type, DOC#CERTIFICATE_OF_ORIGIN still MISSING, plan send_email(REMINDER) naming the missing document — needs ${NEEDS.intake}; ${NEEDS.seed}; ${NEEDS.simMail}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-026:pending] UNKNOWN_DOC: reading UNRECOGNIZED, PDF under unrecognized/, Escalation UNRECOGNIZED_DOCUMENT, document status unchanged; plan tells the supplier the firm reviews it — needs ${NEEDS.intake}; ${NEEDS.simMail}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-027:pending] PROMISE reply without attachments: plan schedule_followup(SUPPLIER, next business day 10:00 supplier time, PROMISED_BY_SUPPLIER) → TIMER#FOLLOWUP_DUE# SCHEDULED (adjustedBy when out of hours); at its time, a REMINDER only if the document did not arrive — needs ${NEEDS.simMail}; ${NEEDS.tools}; ${NEEDS.timers}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-028:pending] NEVER supplier (op-4478): FOLLOWUP and FOLLOWUP_FINAL milestones → one REMINDER per contact per day and lastReminderAt; LATE supplier: the late reply follows FL-021/FL-022 without duplicated reminders — needs ${NEEDS.seed}; ${NEEDS.timers}; ${NEEDS.simMail}; ${NEEDS.worker}; ${NEEDS.pipeline}`,
  );
  it.todo(
    `[FL-029:pending] SES Bounce Permanent of the op-4474 contact: apply_email_event → Message OUT EMAIL BOUNCED, CONTACT# BOUNCED, turn EMAIL_BOUNCED with plan send_whatsapp(CONTACT_REQUEST, template legajo_contacto_proveedor), TIMER CONTACT_CHECK — needs ${NEEDS.channelEvents}; ${NEEDS.services}; ${NEEDS.worker}; ${NEEDS.pipeline}`,
  );
});
