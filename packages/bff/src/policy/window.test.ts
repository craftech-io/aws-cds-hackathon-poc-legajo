import { describe, expect, it } from "vitest";
import { evaluate } from "./engine";
import { inbound, replyToImporter, sentToImporter, sentToSupplier, toImporter } from "./testing";

const REMINDER_TEMPLATE = { name: "legajo_recordatorio" as const, params: ["4471", "packing list"] };

describe("[FL-055] 24-hour window", () => {
  it("[FL-055] (a) free text inside the window goes out", () => {
    const decision = evaluate(replyToImporter({}, "2026-10-14T12:00:00-03:00"));
    expect(decision).toMatchObject({ outcome: "ALLOW", window: { state: "OPEN", lastInboundAt: "2026-10-14T12:00:00-03:00", closesAt: "2026-10-15T12:00:00-03:00" } });
  });

  it("[FL-055] (b) free text 25 hours after the importer's last message needs a template", () => {
    const decision = evaluate(replyToImporter({ message: { trigger: "MILESTONE", kind: "REMINDER" } }, "2026-10-14T09:00:00-03:00"));
    expect(decision).toMatchObject({ outcome: "DENY", ruleIds: ["CP-WA-24H"], errorCode: "TEMPLATE_REQUIRED", window: { state: "CLOSED", closesAt: "2026-10-15T09:00:00-03:00" } });
    expect(decision.reason).toBe("free text outside the 24-hour window (the importer last wrote at 2026-10-14T09:00:00-03:00): only an approved template may go out");
  });

  it("[FL-055] (b) the approved template goes out outside the window", () => {
    const decision = evaluate(toImporter({ history: [inbound("msg-in1", "2026-10-14T09:00:00-03:00")], message: { kind: "REMINDER", template: REMINDER_TEMPLATE } }));
    expect(decision).toMatchObject({ outcome: "ALLOW", window: { state: "CLOSED" } });
    expect(decision.evaluated.find((entry) => entry.ruleId === "CP-WA-24H")?.detail).toBe("approved template legajo_recordatorio: allowed inside and outside the window");
  });

  it("[FL-055] exactly 24 hours after the importer's message the window is closed", () => {
    expect(evaluate(replyToImporter({ message: { trigger: undefined } }, "2026-10-14T10:00:00-03:00")).ruleIds).toEqual(["CP-WA-24H"]);
    expect(evaluate(replyToImporter({ message: { trigger: undefined } }, "2026-10-14T10:00:01-03:00")).outcome).toBe("ALLOW");
  });

  it("[FL-055] an upload through the link opens no window: the acknowledgement needs a template", () => {
    // The importer only received the milestone's template and uploaded by the link: no inbound message.
    const history = [sentToImporter("msg-01", "DOCS_REQUEST", "2026-10-15T09:00:00-03:00")];
    const decision = evaluate(replyToImporter({ history, message: { trigger: "UPLOAD_COMPLETED", text: "Recibimos el certificado de origen; falta el packing list." } }));
    expect(decision).toMatchObject({ outcome: "DENY", ruleIds: ["CP-WA-24H"], errorCode: "TEMPLATE_REQUIRED", reply: false, window: { state: "CLOSED" } });
    expect(decision.reason).toContain("the importer never wrote");
  });

  it("[FL-055] runs on real time when WhatsApp is live and on the world's clock when it is simulated", () => {
    // The world jumped two simulated days while only five real minutes went by.
    const history = [inbound("msg-in1", "2026-10-13T10:00:00-03:00", "2026-09-26T14:55:00.000Z")];
    const input = { history, message: { trigger: undefined } };
    expect(evaluate(replyToImporter({ ...input, modes: { email: "live", whatsapp: "live" } })).outcome).toBe("ALLOW");
    expect(evaluate(replyToImporter({ ...input, modes: { email: "live", whatsapp: "simulated" } })).ruleIds).toEqual(["CP-WA-24H"]);
  });

  it("[FL-055] only the operation importer's own WhatsApp messages open it, and none from after the instant", () => {
    const others = [
      { ...inbound("msg-in1", "2026-10-15T09:00:00-03:00"), importerId: "imp-patagonia" },
      { ...inbound("msg-in2", "2026-10-15T09:00:00-03:00"), channel: "EMAIL" as const, counterpart: "SUPPLIER" as const, importerId: undefined },
      sentToSupplier("msg-03", "DOCS_REQUEST", "2026-10-15T09:10:00-03:00"),
      inbound("msg-in4", "2026-10-15T10:30:00-03:00"),
    ];
    expect(evaluate(replyToImporter({ history: others, message: { trigger: undefined } })).window).toEqual({ state: "CLOSED" });
  });

  it("[FL-055] fails closed on free text without the importer's history", () => {
    expect(evaluate(replyToImporter({ history: undefined, message: { trigger: undefined } }))).toMatchObject({ outcome: "DENY", ruleIds: ["CP-WA-24H"], reason: "the importer's message history is missing: the policy fails closed" });
  });
});

describe("replies to the importer", () => {
  it("names the message it answers; a message outside its own window makes no reply", () => {
    const history = [inbound("msg-old", "2026-10-14T08:00:00-03:00"), inbound("msg-new", "2026-10-15T09:30:00-03:00")];
    expect(evaluate(replyToImporter({ history, at: "2026-10-15T20:00:00-03:00", message: { answers: "msg-new" } })).reply).toBe(true);
    expect(evaluate(replyToImporter({ history, at: "2026-10-15T20:00:00-03:00", message: { answers: "msg-old" } })).reply).toBe(false);
    expect(evaluate(replyToImporter({ history, at: "2026-10-15T20:00:00-03:00", message: { answers: "msg-unknown" } })).reply).toBe(false);
  });

  it("the turn a message of the importer opened answers the last one; other turns answer nobody", () => {
    expect(evaluate(replyToImporter({ message: { trigger: "CONTACT_CONFIRMED" } })).reply).toBe(true);
    for (const trigger of ["SUPPLIER_EMAIL", "DOCUMENT_READ", "UPLOAD_COMPLETED", "BROKER_RELEASED"] as const) {
      expect(evaluate(replyToImporter({ message: { trigger } })).reply).toBe(false);
    }
  });
});
