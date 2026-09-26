import { describe, expect, it } from "vitest";
import { evaluate } from "./engine";
import { toPolicyResult } from "./result";
import { inbound, replyToImporter, toImporter, toSupplier } from "./testing";

const MADRID = { supplierId: "sup-qingdao", timezone: "Europe/Madrid" };

function sameInstant(iso: string | undefined, expected: string): boolean {
  return iso !== undefined && Date.parse(iso) === Date.parse(expected);
}

describe("[FL-033] email out of the supplier's business hours", () => {
  it("[FL-033] defers an email written at 23:00 in Qingdao to 09:00 of Qingdao's next business day", () => {
    const decision = evaluate(toSupplier({ at: "2026-10-15T23:00:00+08:00" }));
    expect(decision).toMatchObject({ outcome: "DEFER", allowed: false, deferred: true, ruleIds: ["CP-HOURS-SUPPLIER"], errorCode: "DEFERRED", nextAllowedAt: "2026-10-16T09:00:00+08:00" });
    expect(decision.reason).toBe("THU 15/10 23:00 is outside the supplier's (Asia/Shanghai) business hours: deferred to 2026-10-16T09:00:00+08:00");
    expect(toPolicyResult(decision)).toEqual({ allowed: false, ruleIds: ["CP-HOURS-SUPPLIER"], reason: decision.reason, nextAllowedAt: "2026-10-16T09:00:00+08:00" });
  });

  it("[FL-033] the story's email at 21:00 in Qingdao goes out at 22:00 in Buenos Aires, and then passes", () => {
    const decision = evaluate(toSupplier({ at: "2026-10-15T10:05:00-03:00" }));
    expect(sameInstant(decision.nextAllowedAt, "2026-10-15T22:00:00-03:00")).toBe(true);
    expect(evaluate(toSupplier({ at: decision.nextAllowedAt ?? "" })).outcome).toBe("ALLOW");
  });

  it("[FL-033] a Friday evening in Qingdao waits for Monday", () => {
    expect(evaluate(toSupplier({ at: "2026-10-16T18:00:00+08:00" })).nextAllowedAt).toBe("2026-10-19T09:00:00+08:00");
    expect(evaluate(toSupplier({ at: "2026-10-17T11:00:00+08:00" })).nextAllowedAt).toBe("2026-10-19T09:00:00+08:00");
  });

  it("[FL-033] follows the supplier's daylight saving time", () => {
    // Europe/Madrid leaves summer time on Sunday 25/10/2026: Friday is +02:00, Monday +01:00.
    const decision = evaluate(toSupplier({ supplier: MADRID, at: "2026-10-23T18:30:00+02:00" }));
    expect(decision.nextAllowedAt).toBe("2026-10-26T09:00:00+01:00");
    expect(sameInstant(decision.nextAllowedAt, "2026-10-26T05:00:00-03:00")).toBe(true);
    expect(evaluate(toSupplier({ supplier: MADRID, at: "2026-10-26T09:00:00+01:00" })).outcome).toBe("ALLOW");
  });

  it("[FL-033] sends inside the supplier's hours and fails closed without the supplier's zone", () => {
    expect(evaluate(toSupplier()).outcome).toBe("ALLOW");
    expect(evaluate(toSupplier({ supplier: undefined }))).toMatchObject({ outcome: "DENY", ruleIds: ["CP-HOURS-SUPPLIER"], reason: "the supplier's time zone is missing: the policy fails closed" });
  });

  it("[FL-033] Argentina's hours never apply to the supplier's email", () => {
    const decision = evaluate(toSupplier({ at: "2026-10-16T09:30:00+08:00" }));
    expect(decision.outcome).toBe("ALLOW");
    expect(decision.evaluated.find((entry) => entry.ruleId === "CP-HOURS-AR")?.result).toBe("SKIP");
  });
});

describe("[FL-056] out of Argentina's business hours", () => {
  it("[FL-056] defers a proactive WhatsApp at 20:00 to 09:00 of the next business day", () => {
    const decision = evaluate(toImporter({ at: "2026-10-15T20:00:00-03:00" }));
    expect(decision).toMatchObject({ outcome: "DEFER", ruleIds: ["CP-HOURS-AR"], errorCode: "DEFERRED", nextAllowedAt: "2026-10-16T09:00:00-03:00" });
  });

  it("[FL-056] 18:00 sharp is closed, 09:00 sharp is open, and a Friday evening waits for Monday", () => {
    expect(evaluate(toImporter({ at: "2026-10-16T18:00:00-03:00" })).nextAllowedAt).toBe("2026-10-19T09:00:00-03:00");
    expect(evaluate(toImporter({ at: "2026-10-17T11:00:00-03:00" })).nextAllowedAt).toBe("2026-10-19T09:00:00-03:00");
    expect(evaluate(toImporter({ at: "2026-10-16T09:00:00-03:00" })).outcome).toBe("ALLOW");
    expect(evaluate(toImporter({ at: "2026-10-16T17:59:00-03:00" })).outcome).toBe("ALLOW");
  });

  it("[FL-056] a reply to the importer's own message is not deferred", () => {
    const decision = evaluate(replyToImporter({ at: "2026-10-15T20:00:00-03:00" }, "2026-10-15T19:55:00-03:00"));
    expect(decision).toMatchObject({ outcome: "ALLOW", reply: true });
    expect(decision.evaluated.find((entry) => entry.ruleId === "CP-HOURS-AR")).toEqual({ ruleId: "CP-HOURS-AR", result: "SKIP", detail: "a reply to the importer's own message is exempt from business hours" });
  });

  it("[FL-056] the buttons sent in the turn a message of the importer opened are a reply too", () => {
    const decision = evaluate(toImporter({ at: "2026-10-15T21:10:00-03:00", history: [inbound("msg-btn", "2026-10-15T21:09:00-03:00")], message: { kind: "CONTACT_CONFIRMATION", trigger: "IMPORTER_MESSAGE", template: undefined, text: "¿Le escribimos a s•••@sim.legajo.demo.craftech.io?" } }));
    expect(decision.outcome).toBe("ALLOW");
  });

  it("[FL-056] the acknowledgement of an upload is not a reply: it waits for business hours", () => {
    const decision = evaluate(replyToImporter({ at: "2026-10-15T20:00:00-03:00", message: { trigger: "UPLOAD_COMPLETED", text: "Recibimos el certificado de origen; falta el packing list." } }, "2026-10-15T12:00:00-03:00"));
    expect(decision).toMatchObject({ outcome: "DEFER", reply: false, ruleIds: ["CP-HOURS-AR"], nextAllowedAt: "2026-10-16T09:00:00-03:00" });
  });

  it("[FL-056] a message of the importer that is too old makes no reply", () => {
    const decision = evaluate(replyToImporter({ at: "2026-10-15T20:00:00-03:00" }, "2026-10-14T19:00:00-03:00"));
    expect(decision).toMatchObject({ outcome: "DEFER", reply: false, ruleIds: ["CP-HOURS-AR"] });
  });

  it("[FL-056] fails closed without Argentina's holiday calendar or the importer's history", () => {
    expect(evaluate(toImporter({ holidays: undefined })).reason).toBe("the holiday calendar of Argentina is missing: the policy fails closed");
    expect(evaluate(replyToImporter({ history: undefined })).ruleIds).toEqual(["CP-HOURS-AR"]);
  });
});
