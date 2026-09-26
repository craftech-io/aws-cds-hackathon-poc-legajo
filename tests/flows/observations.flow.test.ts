// Local flows of the findings of the reader (docs/flows-catalog.md, areas C and D): the correction
// request in the same thread, the corrected version, the two-attempt rule, the responsibility matrix
// and a scripted assignment that departs from it. The reader mock returns the observation from its
// ground truth; the plans call `read_document` and `assign_responsible` as the model would.
import { describe, it } from "vitest";
import { NEEDS } from "./support/pending";

describe("observation flows", () => {
  it.todo(
    `[FL-022:pending] op-4471 packing list v1 with GROSS_WEIGHT_MISMATCH (12480 vs 12840 kg): turn DOCUMENT_READ, plan read_document → assign_responsible(SUPPLIER) → send_email(CORRECTION_REQUEST, In-Reply-To of the thread) → send_whatsapp(NO_ACTION_NEEDED); DOC# WITH_OBSERVATION, OBS# CORRECTION_REQUESTED attempts 1 matchesMatrix true, both messages with refs.observationIds — needs ${NEEDS.intake}; ${NEEDS.tools}; ${NEEDS.pipeline}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-023:pending] packing list v2 without observations: OBS# RESOLVED resolvedByVersion 2, DOC# VALID currentVersion 2, turn informs the importer — needs ${NEEDS.intake}; ${NEEDS.simMail}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-024:pending] SEEDED_ERROR_TWICE: the corrected version returns the same code → attempts 2 → ESCALATED (deterministic), Escalation OBSERVATION_ATTEMPTS, MailboxMessage in the firm's mailbox, no third CORRECTION_REQUEST after the queue drains — needs ${NEEDS.intake}; ${NEEDS.simMail}; ${NEEDS.tools}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-039:pending] op-4484 invoice with BUYER_DATA_MISMATCH: assign_responsible(IMPORTER) by the matrix → send_whatsapp(CORRECTION_REQUEST) without asking for tax ids → on confirmation send_email(CORRECTION_REQUEST) with the registry data; observation responsible IMPORTER then SUPPLIER, matchesMatrix true both times — needs ${NEEDS.tools}; ${NEEDS.pipeline}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-041:pending] op-4486 certificate with MISSING_SIGNATURE: assign_responsible(SUPPLIER) → send_email(CORRECTION_REQUEST) → importer NO_ACTION_NEEDED; same state as FL-022 with code MISSING_SIGNATURE — needs ${NEEDS.tools}; ${NEEDS.pipeline}; ${NEEDS.worker}`,
  );
  it.todo(
    `[FL-042:pending] scripted plan assigns IMPORTER to an observation whose matrix row says SUPPLIER: assign_responsible answers matchesMatrix false, flaggedForReview true; operations.get shows it flagged and the correct-responsible KPI counts it as wrong — needs ${NEEDS.tools}; ${NEEDS.intake}; ${NEEDS.worker}`,
  );
});
