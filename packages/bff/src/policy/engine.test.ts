import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTACT_POLICY_RULES } from "@legajo/shared";
import { evaluate } from "./engine";
import { toPolicyResult } from "./result";
import { NORPAMPA, OPERATION_4471, QINGDAO_CONTACT, SEEDED_AT, inbound, replyToImporter, toImporter, toSupplier } from "./testing";
import type { PolicyDecision } from "./types";

const TAKEN_AT = "2026-10-15T09:00:00-03:00";
const takenOver = { ...OPERATION_4471, control: "BROKER" as const, controlHistory: [...OPERATION_4471.controlHistory, { control: "BROKER" as const, atSim: TAKEN_AT, by: "BROKER:brk-delta-martina" as const }] };
const approved = { ...OPERATION_4471, dossierStatus: "APPROVED" as const, dossierHistory: [...OPERATION_4471.dossierHistory, { status: "READY_FOR_REVIEW" as const, atSim: "2026-10-14T11:00:00-03:00", by: "AGENT" as const }, { status: "APPROVED" as const, atSim: "2026-10-14T12:00:00-03:00", by: "BROKER:brk-delta-diego" as const }] };
const noConsent = { ...NORPAMPA, consent: undefined };
const revoked = { ...NORPAMPA, consent: { revokedAt: "2026-10-14T16:00:00-03:00", history: [...NORPAMPA.consent.history, { action: "REVOKED" as const, atSim: "2026-10-14T16:00:00-03:00", by: "IMPORTER" as const }] } };

function denied(decision: PolicyDecision) {
  return { outcome: decision.outcome, ruleIds: decision.ruleIds, errorCode: decision.errorCode };
}

describe("contact policy engine: order and outcome", () => {
  afterEach(() => vi.useRealTimers());

  it("allows a clean template to the importer, judging all 14 rules in order and listing the ones that passed", () => {
    const decision = evaluate(toImporter());
    expect(decision).toMatchObject({ outcome: "ALLOW", allowed: true, deferred: false, reply: false, window: { state: "CLOSED" } });
    expect(decision.evaluated.map((entry) => entry.ruleId)).toEqual([...CONTACT_POLICY_RULES]);
    expect(decision.ruleIds).toEqual(["CP-CONTROL-BROKER", "CP-KIND-CHANNEL", "CP-RECIPIENT-FENCE", "CP-OPTIN", "CP-OPTOUT", "CP-APPROVED-SCOPE", "CP-HOURS-AR", "CP-ONE-PER-DAY", "CP-WA-24H", "CP-NO-SENSITIVE-ASK", "CP-NO-FOREIGN-LINKS"]);
    expect(decision.evaluated.filter((entry) => entry.result === "SKIP").map((entry) => entry.ruleId)).toEqual(["CP-SUPPLIER-AUTH", "CP-BOUNCED-CONTACT", "CP-HOURS-SUPPLIER"]);
    expect(toPolicyResult(decision)).toEqual({ allowed: true, ruleIds: decision.ruleIds });
  });

  it("stops at the first rule that denies and reports it alone", () => {
    const decision = evaluate(toImporter({ operation: takenOver, importer: noConsent }));
    expect(denied(decision)).toEqual({ outcome: "DENY", ruleIds: ["CP-CONTROL-BROKER"], errorCode: "CONTROL_BROKER" });
    expect(decision.evaluated).toHaveLength(1);
    expect(toPolicyResult(decision)).toEqual({ allowed: false, ruleIds: ["CP-CONTROL-BROKER"], reason: "the firm has taken the conversation: the agent does not send" });
  });

  it("in exhaustive mode judges every rule and lists every breach, the first one deciding", () => {
    const decision = evaluate(toImporter({ operation: takenOver, importer: noConsent }), { exhaustive: true });
    expect(denied(decision)).toEqual({ outcome: "DENY", ruleIds: ["CP-CONTROL-BROKER", "CP-OPTIN"], errorCode: "CONTROL_BROKER" });
    expect(decision.evaluated).toHaveLength(CONTACT_POLICY_RULES.length);
  });

  it("reports the earliest breached rule of docs/design-brief.md §5.7 whatever else is wrong", () => {
    const bounced = { ...QINGDAO_CONTACT, status: "BOUNCED" as const, statusHistory: [...QINGDAO_CONTACT.statusHistory, { status: "BOUNCED" as const, atSim: TAKEN_AT, by: "SYSTEM" as const }] };
    const unauthorized = { ...NORPAMPA, authorization: undefined };
    expect(evaluate(toSupplier({ contact: bounced, importer: unauthorized }), { exhaustive: true }).ruleIds).toEqual(["CP-SUPPLIER-AUTH", "CP-BOUNCED-CONTACT"]);
    const lateReminder = { at: "2026-10-15T20:00:00-03:00", operation: approved, message: { kind: "REMINDER" as const, template: undefined, text: "Recordá subir el packing list." } };
    expect(evaluate(toImporter(lateReminder), { exhaustive: true }).ruleIds).toEqual(["CP-APPROVED-SCOPE", "CP-HOURS-AR", "CP-WA-24H"]);
    expect(evaluate(toImporter({ ...lateReminder, operation: OPERATION_4471 }))).toMatchObject({ outcome: "DEFER", ruleIds: ["CP-HOURS-AR"] });
  });

  it("lets the firm write while it has the conversation, and honours a current control the history lags behind", () => {
    const broker = { author: "BROKER:brk-delta-martina", kind: "BROKER_MESSAGE" as const, template: undefined, text: "Hola Lucía, te escribo desde el estudio.", trigger: undefined };
    expect(evaluate(toImporter({ operation: takenOver, message: broker, history: [inbound("msg-in1", "2026-10-15T09:40:00-03:00")] })).outcome).toBe("ALLOW");
    const lagging = { ...OPERATION_4471, control: "BROKER" as const };
    expect(denied(evaluate(toImporter({ operation: lagging })))).toMatchObject({ ruleIds: ["CP-CONTROL-BROKER"] });
  });

  it("never reads the machine's clock: the same input gives the same decision in any year", () => {
    const inputs = [toImporter(), toImporter({ at: "2026-10-15T20:00:00-03:00" }), toSupplier({ at: "2026-10-15T12:00:00-03:00" })];
    const before = inputs.map((input) => evaluate(input));
    vi.useFakeTimers({ now: new Date("2031-03-01T03:00:00.000Z") });
    expect(inputs.map((input) => evaluate(input))).toEqual(before);
  });
});

describe("CP-KIND-CHANNEL and CP-RECIPIENT-FENCE", () => {
  it("keeps each kind on its channel and recipient (docs/design-brief.md §3)", () => {
    expect(denied(evaluate(toImporter({ message: { channel: "EMAIL" } })))).toEqual({ outcome: "DENY", ruleIds: ["CP-KIND-CHANNEL"], errorCode: "POLICY_DENIED" });
    expect(evaluate(toImporter({ message: { kind: "ESCALATION" } })).ruleIds).toEqual(["CP-KIND-CHANNEL"]);
    expect(evaluate(toImporter({ message: { kind: undefined } })).reason).toBe("the message kind is missing: the policy fails closed");
    expect(evaluate(toSupplier({ message: { kind: "APPROVAL_NOTICE" } })).ruleIds).toEqual(["CP-KIND-CHANNEL"]);
    const escalation = toSupplier({ message: { counterpart: "FIRM", kind: "ESCALATION", author: "SYSTEM", to: "estudio-delta@sim.legajo.demo.craftech.io", contactId: undefined, text: "Operation 4471 needs the firm." } });
    expect(evaluate(escalation).outcome).toBe("ALLOW");
  });

  it("sends a correction request to the importer only when the importer is responsible", () => {
    const correction = (responsibles?: ("IMPORTER" | "SUPPLIER")[]) =>
      evaluate(replyToImporter({ message: { kind: "CORRECTION_REQUEST", text: "¿Nos confirmás la razón social del comprador que figura en la factura?", responsibles } }));
    expect(correction(["IMPORTER"]).outcome).toBe("ALLOW");
    expect(correction(["SUPPLIER"]).reason).toBe("a correction request goes to the importer only when the importer is responsible");
    expect(correction(undefined).ruleIds).toEqual(["CP-KIND-CHANNEL"]);
  });

  it("fails closed on an email without the fence's verdict and reports the fence's own denial", () => {
    expect(denied(evaluate(toSupplier({ fence: undefined })))).toEqual({ outcome: "DENY", ruleIds: ["CP-RECIPIENT-FENCE"], errorCode: "RECIPIENT_NOT_ALLOWED" });
    expect(evaluate(toSupplier({ fence: { allowed: false, detail: "reserved domain" } })).reason).toBe("reserved domain");
  });

  it("fences a WhatsApp to the importer's registered phone", () => {
    expect(evaluate(toImporter({ message: { to: "+54 9 11 5550-0101" } })).outcome).toBe("ALLOW");
    expect(denied(evaluate(toImporter({ message: { to: "+5491155500199" } })))).toMatchObject({ ruleIds: ["CP-RECIPIENT-FENCE"], errorCode: "RECIPIENT_NOT_ALLOWED" });
    expect(evaluate(toImporter({ message: { to: undefined } })).reason).toBe("the recipient fence verdict is missing: the policy fails closed");
  });
});

describe("[FL-002] importer without opt-in", () => {
  it("[FL-002] denies the milestone's WhatsApp with CP-OPTIN and sends nothing", () => {
    const decision = evaluate(toImporter({ importer: noConsent }));
    expect(denied(decision)).toEqual({ outcome: "DENY", ruleIds: ["CP-OPTIN"], errorCode: "POLICY_DENIED" });
    expect(decision).toMatchObject({ allowed: false, deferred: false, reason: "the importer has no WhatsApp opt-in" });
  });

  it("[FL-002] an opt-in granted after the instant does not count yet", () => {
    const later = { ...NORPAMPA, consent: { history: [{ action: "GRANTED" as const, atSim: "2026-10-15T11:00:00-03:00", by: "BROKER:brk-delta-martina" as const }] } };
    expect(evaluate(toImporter({ importer: later })).ruleIds).toEqual(["CP-OPTIN"]);
  });
});

describe("[FL-006] revoking the opt-in or the authorization from the console", () => {
  it("[FL-006] the next WhatsApp after a revoked opt-in is denied with CP-OPTOUT", () => {
    expect(denied(evaluate(toImporter({ importer: revoked })))).toEqual({ outcome: "DENY", ruleIds: ["CP-OPTOUT"], errorCode: "POLICY_DENIED" });
  });

  it("[FL-006] the next email after the authorization is removed is denied with CP-SUPPLIER-AUTH", () => {
    const removed = { ...NORPAMPA, authorization: { authorized: false, history: [...NORPAMPA.authorization.history, { action: "REVOKED" as const, atSim: "2026-10-15T09:00:00-03:00", by: "BROKER:brk-delta-martina" as const }] } };
    expect(denied(evaluate(toSupplier({ importer: removed })))).toEqual({ outcome: "DENY", ruleIds: ["CP-SUPPLIER-AUTH"], errorCode: "POLICY_DENIED" });
    expect(evaluate(toSupplier({ importer: { ...NORPAMPA, authorization: undefined } })).reason).toBe("the importer has not authorized the agent to write to this supplier");
  });
});

describe("[FL-016] opt-out by button or keyword", () => {
  it("[FL-016] the fixed confirmation still goes out, even at night, answering the opt-out message", () => {
    const confirmation = replyToImporter({ importer: revoked, at: "2026-10-14T21:05:00-03:00", message: { kind: "OPT_OUT_CONFIRMATION", text: "Listo, no te vamos a mandar más avisos por WhatsApp.", trigger: undefined } }, "2026-10-14T21:00:00-03:00");
    const decision = evaluate(confirmation);
    expect(decision).toMatchObject({ outcome: "ALLOW", reply: true });
    expect(decision.evaluated.find((entry) => entry.ruleId === "CP-HOURS-AR")?.result).toBe("SKIP");
  });

  it("[FL-016] the next milestone is denied with CP-OPTOUT", () => {
    expect(evaluate(toImporter({ importer: revoked })).ruleIds).toEqual(["CP-OPTOUT"]);
  });
});

describe("CP-SUPPLIER-AUTH and CP-BOUNCED-CONTACT", () => {
  it("writes only to a confirmed contact of the operation's supplier", () => {
    const pending = { ...QINGDAO_CONTACT, status: "PENDING_CONFIRMATION" as const, statusHistory: [{ status: "PENDING_CONFIRMATION" as const, atSim: SEEDED_AT, by: "AGENT" as const }] };
    expect(evaluate(toSupplier({ contact: pending })).ruleIds).toEqual(["CP-SUPPLIER-AUTH"]);
    expect(evaluate(toSupplier({ contact: { ...QINGDAO_CONTACT, supplierId: "sup-konkan" } })).reason).toBe("the contact is not a contact of the operation's supplier");
    expect(evaluate(toSupplier({ contact: undefined })).reason).toBe("the email has no registered contact of the supplier");
    expect(evaluate(toSupplier({ message: { contactId: "ctc-qingdao-2" } })).reason).toBe("the contact given is not the message's contact");
    expect(evaluate(toSupplier({ supplier: { supplierId: "sup-konkan", timezone: "Asia/Kolkata" } })).ruleIds).toEqual(["CP-SUPPLIER-AUTH"]);
  });

  it("never writes to a contact that bounced or complained", () => {
    const bounced = { ...QINGDAO_CONTACT, status: "BOUNCED" as const, statusHistory: [...QINGDAO_CONTACT.statusHistory, { status: "BOUNCED" as const, atSim: "2026-10-15T20:00:00-03:00", by: "SYSTEM" as const }] };
    expect(denied(evaluate(toSupplier({ contact: bounced })))).toEqual({ outcome: "DENY", ruleIds: ["CP-BOUNCED-CONTACT"], errorCode: "POLICY_DENIED" });
    expect(evaluate(toSupplier({ contact: { ...QINGDAO_CONTACT, status: "COMPLAINED" as const } })).reason).toBe("the contact complained: it is never written to again");
  });
});

describe("[FL-058] approved dossier: scope of messages", () => {
  it("[FL-058] asks nobody for anything: no reminder to the importer, nothing to the supplier", () => {
    const reminder = evaluate(toImporter({ operation: approved, message: { kind: "REMINDER", template: { name: "legajo_recordatorio", params: ["4471"] } } }));
    expect(denied(reminder)).toEqual({ outcome: "DENY", ruleIds: ["CP-APPROVED-SCOPE"], errorCode: "POLICY_DENIED" });
    for (const kind of ["CORRECTION_REQUEST", "REMINDER", "REPLY"] as const) expect(evaluate(toSupplier({ operation: approved, message: { kind } })).ruleIds).toEqual(["CP-APPROVED-SCOPE"]);
  });

  it("[FL-058] still sends the approval notice, the dispatch status and the opt-out confirmation", () => {
    expect(evaluate(toImporter({ operation: approved, message: { kind: "APPROVAL_NOTICE", template: { name: "legajo_aprobado", params: ["4471"] } } })).outcome).toBe("ALLOW");
    expect(evaluate(toImporter({ operation: approved, message: { kind: "DISPATCH_STATUS", template: { name: "despacho_estado", params: ["4471", "LIBERADO"] } } })).outcome).toBe("ALLOW");
    expect(evaluate(replyToImporter({ operation: approved, importer: revoked, message: { kind: "OPT_OUT_CONFIRMATION", text: "Listo, no te vamos a mandar más avisos." } })).outcome).toBe("ALLOW");
  });

  it("[FL-058] admits the REPLY to the importer's own question (FL-053), never one of an upload's turn", () => {
    expect(evaluate(replyToImporter({ operation: approved })).outcome).toBe("ALLOW");
    const upload = evaluate(replyToImporter({ operation: approved, message: { trigger: "UPLOAD_COMPLETED" } }));
    expect(upload.ruleIds).toEqual(["CP-APPROVED-SCOPE"]);
    expect(evaluate(toImporter({ operation: approved, message: { kind: "BROKER_MESSAGE", author: "BROKER:brk-delta-diego" } })).ruleIds).toEqual(["CP-APPROVED-SCOPE"]);
  });

  it("[FL-058] the scope ends when the dossier is reopened", () => {
    const reopened = { ...approved, dossierStatus: "REOPENED" as const, dossierHistory: [...approved.dossierHistory, { status: "REOPENED" as const, atSim: "2026-10-15T08:00:00-03:00", by: "BROKER:brk-delta-diego" as const }] };
    expect(evaluate(toSupplier({ operation: reopened })).outcome).toBe("ALLOW");
  });
});

describe("CP-NO-SENSITIVE-ASK and CP-NO-FOREIGN-LINKS", () => {
  it("denies a text that asks for bank or identity data, and lets a warning through", () => {
    const ask = evaluate(replyToImporter({ message: { text: "Para seguir, mandanos tu CBU por acá." } }));
    expect(denied(ask)).toEqual({ outcome: "DENY", ruleIds: ["CP-NO-SENSITIVE-ASK"], errorCode: "GROUNDING_FAIL" });
    expect(ask.reason).toContain('"cbu"');
    expect(evaluate(replyToImporter({ message: { text: "Nunca te vamos a pedir tu CBU ni tu clave fiscal por WhatsApp." } })).outcome).toBe("ALLOW");
    expect(evaluate(toSupplier({ message: { text: "Please send us your bank account number." } })).ruleIds).toEqual(["CP-NO-SENSITIVE-ASK"]);
    expect(evaluate(toImporter({ message: { template: { name: "legajo_recordatorio", params: ["mandanos tu DNI"] } } })).ruleIds).toEqual(["CP-NO-SENSITIVE-ASK"]);
  });

  it("takes the foreign-links verdict of the verifier for free text", () => {
    expect(denied(evaluate(toSupplier({ foreignLinks: { allowed: false, detail: "a link that is not the turn's" } })))).toEqual({ outcome: "DENY", ruleIds: ["CP-NO-FOREIGN-LINKS"], errorCode: "GROUNDING_FAIL" });
    expect(evaluate(toSupplier()).evaluated.at(-1)).toEqual({ ruleId: "CP-NO-FOREIGN-LINKS", result: "SKIP", detail: "checked by outbound/verify.ts on the rendered text" });
    expect(evaluate(toImporter()).evaluated.at(-1)?.result).toBe("PASS");
  });
});
