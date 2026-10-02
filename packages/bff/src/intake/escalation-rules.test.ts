import { describe, expect, it } from "vitest";
import { CLOCK, FIRM, REAL_NOW, START_SIM, memoryStores, seedDemoSlice } from "../connector/testing";
import type { SupplierContact } from "../domain/parties";
import { FIRM_EMAIL_REASONS } from "../escalations/escalate";
import {
  ATTEMPT_LIMIT,
  READER_FAILURES_TO_ESCALATE,
  noValidContactEscalation,
  observationAttemptsEscalation,
  readerUnavailableEscalation,
  recordEscalation,
  unrecognizedEscalation,
} from "./escalation-rules";

const OPERATION = { operationId: "op-4474", operationNumber: "4474", firmId: FIRM, clockId: CLOCK };
const DAY_AFTER = "2026-10-15T10:30:00-03:00";

function contact(statuses: readonly { readonly status: SupplierContact["status"]; readonly atSim: string }[], confirmedAt?: string): Pick<SupplierContact, "statusHistory" | "confirmedAt"> {
  return { statusHistory: statuses.map((entry) => ({ ...entry, by: "SYSTEM" as const })), ...(confirmedAt === undefined ? {} : { confirmedAt }) };
}

describe("escalations decided by code", () => {
  it("[FL-030] CONTACT_CHECK without an ACTIVE contact → NO_VALID_CONTACT, which also mails the firm's mailbox", () => {
    const bounced = contact([{ status: "ACTIVE", atSim: "2026-10-01T09:00:00-03:00" }, { status: "BOUNCED", atSim: START_SIM }], "2026-10-01T09:00:00-03:00");
    const request = noValidContactEscalation(OPERATION, [bounced], DAY_AFTER);
    expect(request).toMatchObject({ reason: "NO_VALID_CONTACT", notifyFirm: true, atSim: DAY_AFTER, operation: OPERATION });
    expect(noValidContactEscalation(OPERATION, [], DAY_AFTER)?.reason).toBe("NO_VALID_CONTACT");
  });

  it("[FL-030] with an ACTIVE confirmed contact there is no escalation; a pending one does not count", () => {
    const active = contact([{ status: "ACTIVE", atSim: "2026-10-14T12:00:00-03:00" }], "2026-10-14T12:00:00-03:00");
    expect(noValidContactEscalation(OPERATION, [active], DAY_AFTER)).toBeUndefined();
    const pending = contact([{ status: "PENDING_CONFIRMATION", atSim: "2026-10-14T12:00:00-03:00" }]);
    expect(noValidContactEscalation(OPERATION, [pending], DAY_AFTER)?.reason).toBe("NO_VALID_CONTACT");
    // Confirmed only after the check: not valid at the check's instant.
    const late = contact([{ status: "ACTIVE", atSim: "2026-10-16T09:00:00-03:00" }], "2026-10-16T09:00:00-03:00");
    expect(noValidContactEscalation(OPERATION, [late], DAY_AFTER)?.reason).toBe("NO_VALID_CONTACT");
  });

  it("the attempt rule escalates only at its limit, mailing the firm", () => {
    const observation = { observationId: "obs-4474-PL-GROSS_WEIGHT_MISMATCH", code: "GROSS_WEIGHT_MISMATCH" as const, docType: "PACKING_LIST" as const };
    expect(observationAttemptsEscalation(OPERATION, { ...observation, attempts: ATTEMPT_LIMIT - 1 }, "dv-4474-PL-2", START_SIM)).toBeUndefined();
    expect(observationAttemptsEscalation(OPERATION, { ...observation, attempts: ATTEMPT_LIMIT }, "dv-4474-PL-2", START_SIM)).toMatchObject({ reason: "OBSERVATION_ATTEMPTS", notifyFirm: true, summary: expect.stringContaining("peso bruto") });
  });

  it("the reader escalates at exactly its third failure; an unrecognized PDF always goes to the firm without mailing it", () => {
    const version = { docVersionId: "dv-4474-CI-1", docType: "COMMERCIAL_INVOICE" as const };
    expect(readerUnavailableEscalation(OPERATION, version, READER_FAILURES_TO_ESCALATE - 1, START_SIM)).toBeUndefined();
    expect(readerUnavailableEscalation(OPERATION, version, READER_FAILURES_TO_ESCALATE, START_SIM)).toMatchObject({ reason: "READER_UNAVAILABLE", notifyFirm: false });
    expect(readerUnavailableEscalation(OPERATION, version, READER_FAILURES_TO_ESCALATE + 1, START_SIM)).toBeUndefined();
    expect(unrecognizedEscalation(OPERATION, { docVersionId: "dv-4474-CI-1", source: { party: "SUPPLIER", channel: "EMAIL" } }, START_SIM)).toMatchObject({ reason: "UNRECOGNIZED_DOCUMENT", notifyFirm: false });
    expect([...FIRM_EMAIL_REASONS]).toEqual(["IMPORTER_ASKED", "MISSING_AT_ETA_48H", "OBSERVATION_ATTEMPTS", "UNTRUSTED_SENDER", "NO_VALID_CONTACT"]);
  });

  it("recordEscalation opens one escalation per reason and operation and audits it once", async () => {
    const stores = memoryStores();
    await seedDemoSlice(stores);
    const escalate = recordEscalation(stores.connector, () => new Date(REAL_NOW));
    const request = noValidContactEscalation({ ...OPERATION, operationId: "op-4471", operationNumber: "4471" }, [], DAY_AFTER);
    if (request === undefined) throw new Error("expected an escalation");
    const first = await escalate(request);
    const second = await escalate(request);
    expect(first.created).toBe(true);
    expect(second).toEqual({ escalationId: first.escalationId, created: false });
    const audit = (await stores.connector.audit.listByOperation("op-4471")).filter((row) => row.action === "ESCALATION_OPENED");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ decision: "ACTION", actor: "SYSTEM", reason: "NO_VALID_CONTACT", detail: { notifyFirm: true } });
    expect(request.summary.length).toBeLessThanOrEqual(500);
  });
});
