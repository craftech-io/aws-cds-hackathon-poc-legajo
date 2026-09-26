import { describe, expect, it } from "vitest";
import { evaluate } from "./engine";
import { QINGDAO_CONTACT, inbound, sentToImporter, sentToSupplier, toImporter, toSupplier } from "./testing";

const REMINDER = { kind: "REMINDER" as const, template: { name: "legajo_recordatorio" as const, params: ["4471", "packing list"] } };
const THURSDAY_14_AR = "2026-10-15T14:00:00-03:00";

describe("[FL-057] one reminder per contact per simulated day", () => {
  it("[FL-057] a follow-up and a milestone on the same day: the second waits for the next business day", () => {
    const history = [sentToImporter("msg-01", "DOCS_REQUEST", "2026-10-15T10:00:00-03:00")];
    const decision = evaluate(toImporter({ at: THURSDAY_14_AR, message: REMINDER, history }));
    expect(decision).toMatchObject({ outcome: "DEFER", ruleIds: ["CP-ONE-PER-DAY"], errorCode: "DEFERRED", nextAllowedAt: "2026-10-16T09:00:00-03:00" });
    expect(decision.reason).toBe("a DOCS_REQUEST already reached this contact on 15/10 (Buenos Aires): deferred to 2026-10-16T09:00:00-03:00");
    expect(evaluate(toImporter({ at: "2026-10-16T09:00:00-03:00", message: REMINDER, history })).outcome).toBe("ALLOW");
  });

  it("[FL-057] counts across every operation of the importer, never another importer", () => {
    const otherOperation = [sentToImporter("msg-4478", "REMINDER", "2026-10-15T10:00:00-03:00")];
    expect(evaluate(toImporter({ at: THURSDAY_14_AR, message: REMINDER, history: otherOperation })).ruleIds).toEqual(["CP-ONE-PER-DAY"]);
    const otherImporter = [sentToImporter("msg-01", "REMINDER", "2026-10-15T10:00:00-03:00", { importerId: "imp-patagonia" })];
    expect(evaluate(toImporter({ at: THURSDAY_14_AR, message: REMINDER, history: otherImporter })).outcome).toBe("ALLOW");
  });

  it("[FL-057] only a request or reminder that went out counts", () => {
    const notCounted = [
      sentToImporter("msg-01", "DOCS_REQUEST", "2026-10-15T09:10:00-03:00", { status: "FAILED" }),
      sentToImporter("msg-02", "DOCS_REQUEST", "2026-10-15T09:20:00-03:00", { status: "DEFERRED" }),
      sentToImporter("msg-03", "REMINDER", "2026-10-15T09:30:00-03:00", { status: "QUEUED" }),
      sentToImporter("msg-04", "REPLY", "2026-10-15T09:40:00-03:00"),
      sentToImporter("msg-05", "NO_ACTION_NEEDED", "2026-10-15T09:50:00-03:00", { status: "DELIVERED" }),
      inbound("msg-06", "2026-10-15T11:00:00-03:00"),
    ];
    expect(evaluate(toImporter({ at: THURSDAY_14_AR, message: REMINDER, history: notCounted })).outcome).toBe("ALLOW");
    for (const status of ["DELIVERED", "READ", "DELAYED"] as const) {
      const history = [sentToImporter("msg-01", "REMINDER", "2026-10-15T09:10:00-03:00", { status })];
      expect(evaluate(toImporter({ at: THURSDAY_14_AR, message: REMINDER, history })).ruleIds).toEqual(["CP-ONE-PER-DAY"]);
    }
  });

  it("[FL-057] a deferred send re-evaluated at its hour never counts against itself", () => {
    const history = [sentToImporter("msg-01", "DOCS_REQUEST", "2026-10-15T09:00:00-03:00", { status: "DEFERRED" })];
    expect(evaluate(toImporter({ at: "2026-10-16T09:00:00-03:00", history, message: { messageId: "msg-01" } })).outcome).toBe("ALLOW");
  });

  it("[FL-057] another day, another cap; replies and acknowledgements are never capped", () => {
    const yesterday = [sentToImporter("msg-01", "DOCS_REQUEST", "2026-10-14T10:00:00-03:00")];
    expect(evaluate(toImporter({ message: REMINDER, history: yesterday })).outcome).toBe("ALLOW");
    const today = [sentToImporter("msg-01", "DOCS_REQUEST", "2026-10-15T09:00:00-03:00"), inbound("msg-in", "2026-10-15T09:30:00-03:00")];
    const reply = evaluate(toImporter({ history: today, message: { kind: "REPLY", template: undefined, text: "Te mandamos el link para subir el packing list.", trigger: "IMPORTER_MESSAGE" } }));
    expect(reply.outcome).toBe("ALLOW");
    expect(reply.evaluated.find((entry) => entry.ruleId === "CP-ONE-PER-DAY")?.result).toBe("SKIP");
  });

  it("[FL-057] for the supplier the day is the supplier's own day, per contact", () => {
    // 15/10 17:00 and 16/10 09:30 in Qingdao are the same day in Buenos Aires (15/10), not in Qingdao.
    const earlierInQingdao = [sentToSupplier("msg-01", "DOCS_REQUEST", "2026-10-15T17:00:00+08:00")];
    expect(evaluate(toSupplier({ at: "2026-10-16T09:30:00+08:00", message: { kind: "REMINDER" }, history: earlierInQingdao })).outcome).toBe("ALLOW");
    // The same Friday in Qingdao: the second waits for Monday 09:00 in Qingdao.
    const sameDay = [sentToSupplier("msg-01", "DOCS_REQUEST", "2026-10-16T09:30:00+08:00")];
    expect(evaluate(toSupplier({ at: "2026-10-16T17:00:00+08:00", message: { kind: "REMINDER" }, history: sameDay }))).toMatchObject({ outcome: "DEFER", ruleIds: ["CP-ONE-PER-DAY"], nextAllowedAt: "2026-10-19T09:00:00+08:00" });
    const otherContact = [sentToSupplier("msg-01", "DOCS_REQUEST", "2026-10-16T09:30:00+08:00", "ctc-qingdao-2")];
    expect(evaluate(toSupplier({ at: "2026-10-16T17:00:00+08:00", message: { kind: "REMINDER" }, history: otherContact })).outcome).toBe("ALLOW");
  });

  it("[FL-057] the supplier's contact comes from the registry when the message names none", () => {
    const sameDay = [sentToSupplier("msg-01", "DOCS_REQUEST", "2026-10-16T09:30:00+08:00")];
    const decision = evaluate(toSupplier({ at: "2026-10-16T17:00:00+08:00", message: { kind: "REMINDER", contactId: undefined }, history: sameDay, contact: QINGDAO_CONTACT }));
    expect(decision.ruleIds).toEqual(["CP-ONE-PER-DAY"]);
  });

  it("[FL-057] fails closed without the contact's history", () => {
    expect(evaluate(toImporter({ history: undefined }))).toMatchObject({ outcome: "DENY", ruleIds: ["CP-ONE-PER-DAY"], reason: "the contact's message history is missing: the policy fails closed" });
  });
});
