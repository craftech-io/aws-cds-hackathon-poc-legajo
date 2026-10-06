import { afterEach, describe, expect, it, vi } from "vitest";
import { type AsOfFacts, evaluateAsOf } from "./as-of";
import { ARGENTINA_HOLIDAYS, NORPAMPA, OPERATION_4471, QINGDAO, QINGDAO_CONTACT, REAL_NOW, inbound, sentToImporter } from "./testing";

const SENT_AT = "2026-10-15T10:00:00-03:00";
const BEFORE = "2026-10-15T09:00:00-03:00";
const AFTER = "2026-10-15T11:00:00-03:00";

/** A stored WhatsApp template to the importer and the rows the audit loads for it. */
function whatsapp(overrides: Partial<AsOfFacts> = {}, message: Partial<AsOfFacts["message"]> = {}): AsOfFacts {
  return {
    message: { messageId: "msg-01", channel: "WHATSAPP", counterpart: "IMPORTER", kind: "DOCS_REQUEST", author: "AGENT", to: NORPAMPA.phoneE164, template: { name: "legajo_docs_pendientes", params: ["4471"] }, simulated: true, sentAtSim: SENT_AT, sentAtReal: REAL_NOW, ...message },
    trigger: "MILESTONE",
    operation: OPERATION_4471,
    importer: { phoneE164: NORPAMPA.phoneE164 },
    consent: NORPAMPA.consent,
    holidays: ARGENTINA_HOLIDAYS,
    history: [],
    ...overrides,
  };
}

/** A stored email to the Qingdao contact, 11:00 in Qingdao. */
function email(overrides: Partial<AsOfFacts> = {}, message: Partial<AsOfFacts["message"]> = {}): AsOfFacts {
  return {
    message: { messageId: "msg-02", channel: "EMAIL", counterpart: "SUPPLIER", kind: "DOCS_REQUEST", author: "AGENT", to: "supplier-qingdao@sim.legajo.demo.craftech.io", contactId: "ctc-qingdao-1", sentAtSim: "2026-10-15T00:00:00-03:00", sentAtReal: REAL_NOW, ...message },
    trigger: "CONTACT_CONFIRMED",
    operation: OPERATION_4471,
    authorization: NORPAMPA.authorization,
    contact: QINGDAO_CONTACT,
    supplier: QINGDAO,
    history: [],
    ...overrides,
  };
}

const consentRevokedAt = (atSim: string) => ({ history: [...NORPAMPA.consent.history, { action: "REVOKED" as const, atSim, by: "IMPORTER" as const }] });
const controlTakenAt = (atSim: string) => ({ ...OPERATION_4471, controlHistory: [...OPERATION_4471.controlHistory, { control: "BROKER" as const, atSim, by: "BROKER:brk-delta-martina" as const }] });
const approvedAt = (atSim: string) => ({ ...OPERATION_4471, dossierHistory: [...OPERATION_4471.dossierHistory, { status: "APPROVED" as const, atSim, by: "BROKER:brk-delta-diego" as const }] });
const contactBouncedAt = (atSim: string) => ({ ...QINGDAO_CONTACT, statusHistory: [...QINGDAO_CONTACT.statusHistory, { status: "BOUNCED" as const, atSim, by: "SYSTEM" as const }] });

describe("the policy at the instant a message went out", () => {
  afterEach(() => vi.useRealTimers());

  it("allows clean sends of the past", () => {
    expect(evaluateAsOf(whatsapp()).outcome).toBe("ALLOW");
    expect(evaluateAsOf(email()).outcome).toBe("ALLOW");
  });

  it("a revocation, a takeover, an approval or a bounce after the send never makes it a breach", () => {
    expect(evaluateAsOf(whatsapp({ consent: consentRevokedAt(AFTER) })).outcome).toBe("ALLOW");
    expect(evaluateAsOf(whatsapp({ operation: controlTakenAt(AFTER) })).outcome).toBe("ALLOW");
    expect(evaluateAsOf(whatsapp({ operation: approvedAt(AFTER) })).outcome).toBe("ALLOW");
    expect(evaluateAsOf(email({ contact: contactBouncedAt("2026-10-15T01:00:00-03:00") })).outcome).toBe("ALLOW");
    const revokedLater = { history: [...NORPAMPA.authorization.history, { action: "REVOKED" as const, atSim: "2026-10-15T01:00:00-03:00", by: "BROKER:brk-delta-martina" as const }] };
    expect(evaluateAsOf(email({ authorization: revokedLater })).outcome).toBe("ALLOW");
  });

  it("one that was in force when it went out always does", () => {
    expect(evaluateAsOf(whatsapp({ consent: consentRevokedAt(BEFORE) })).ruleIds).toEqual(["CP-OPTOUT"]);
    expect(evaluateAsOf(whatsapp({ operation: controlTakenAt(BEFORE) })).ruleIds).toEqual(["CP-CONTROL-BROKER"]);
    expect(evaluateAsOf(whatsapp({ operation: approvedAt(BEFORE) })).ruleIds).toEqual(["CP-APPROVED-SCOPE"]);
    expect(evaluateAsOf(email({ contact: contactBouncedAt("2026-10-14T23:00:00-03:00") })).ruleIds).toEqual(["CP-BOUNCED-CONTACT"]);
    expect(evaluateAsOf(whatsapp({ consent: undefined })).ruleIds).toEqual(["CP-OPTIN"]);
    expect(evaluateAsOf(email({ contact: undefined })).ruleIds).toEqual(["CP-SUPPLIER-AUTH"]);
  });

  it("[FL-060] [FL-031] in a paused world a takeover or a complaint dated at the send's own simulated instant counts only if it was recorded before the send", () => {
    const later = new Date(Date.parse(REAL_NOW) + 20_000).toISOString();
    const earlier = new Date(Date.parse(REAL_NOW) - 20_000).toISOString();
    const takenAt = (atReal: string) => ({ ...OPERATION_4471, controlHistory: [...OPERATION_4471.controlHistory, { control: "BROKER" as const, atSim: SENT_AT, atReal, by: "BROKER:brk-delta-martina" as const }] });
    expect(evaluateAsOf(whatsapp({ operation: takenAt(later) })).outcome).toBe("ALLOW");
    expect(evaluateAsOf(whatsapp({ operation: takenAt(earlier) })).ruleIds).toEqual(["CP-CONTROL-BROKER"]);
    const sentAtSim = "2026-10-15T00:00:00-03:00";
    const complainedAt = (atReal: string) => ({ ...QINGDAO_CONTACT, statusHistory: [...QINGDAO_CONTACT.statusHistory, { status: "COMPLAINED" as const, atSim: sentAtSim, atReal, by: "SYSTEM" as const }] });
    expect(evaluateAsOf(email({ contact: complainedAt(later) })).outcome).toBe("ALLOW");
    expect(evaluateAsOf(email({ contact: complainedAt(earlier) })).ruleIds).toEqual(["CP-BOUNCED-CONTACT"]);
    // A step without its real instant (the seed's) still counts at its own simulated instant.
    expect(evaluateAsOf(whatsapp({ operation: controlTakenAt(SENT_AT) })).ruleIds).toEqual(["CP-CONTROL-BROKER"]);
  });

  it("checks the hours at the send's own instant: the seeded holiday send of 4478 went out at 09:00 of the 13th", () => {
    // docs/seed-spec.md §3: the milestone of Monday 12/10 (holiday) was deferred to Tuesday 13/10 09:00.
    expect(evaluateAsOf(whatsapp({}, { sentAtSim: "2026-10-13T09:00:00-03:00" })).outcome).toBe("ALLOW");
    expect(evaluateAsOf(whatsapp({}, { sentAtSim: "2026-10-12T10:00:00-03:00" }))).toMatchObject({ outcome: "DEFER", ruleIds: ["CP-HOURS-AR"] });
    expect(evaluateAsOf(email({}, { sentAtSim: "2026-10-15T11:00:00-03:00" })).ruleIds).toEqual(["CP-HOURS-SUPPLIER"]);
  });

  it("tells a reply from a proactive send by the trigger its ALLOW decision recorded", () => {
    const history = [inbound("msg-in", "2026-10-16T22:05:00-03:00")];
    const reply = whatsapp({ trigger: "IMPORTER_MESSAGE", history }, { kind: "REPLY", template: undefined, sentAtSim: "2026-10-16T22:06:00-03:00" });
    expect(evaluateAsOf(reply)).toMatchObject({ outcome: "ALLOW", reply: true });
    expect(evaluateAsOf({ ...reply, trigger: "POLICY_AUDIT" }).ruleIds).toEqual(["CP-HOURS-AR"]);
  });

  it("counts only what went out before the send, never the send itself", () => {
    const first = sentToImporter("msg-01", "DOCS_REQUEST", SENT_AT);
    const second = sentToImporter("msg-02", "REMINDER", "2026-10-15T16:00:00-03:00");
    const history = [first, second];
    expect(evaluateAsOf(whatsapp({ history })).outcome).toBe("ALLOW");
    expect(evaluateAsOf(whatsapp({ history }, { messageId: "msg-02", kind: "REMINDER", sentAtSim: second.sentAtSim })).ruleIds).toEqual(["CP-ONE-PER-DAY"]);
    // Same simulated instant: the real instant, then the id, tells which went first.
    const tied = [sentToImporter("msg-01", "DOCS_REQUEST", SENT_AT, { realAt: "2026-09-26T15:00:01.000Z" }), sentToImporter("msg-02", "REMINDER", SENT_AT)];
    expect(evaluateAsOf(whatsapp({ history: tied }, { messageId: "msg-02", kind: "REMINDER" })).outcome).toBe("ALLOW");
    expect(evaluateAsOf(whatsapp({ history: tied }, { sentAtReal: "2026-09-26T15:00:01.000Z" })).ruleIds).toEqual(["CP-ONE-PER-DAY"]);
  });

  it("runs the window on the clock the message itself was sent on", () => {
    const history = [inbound("msg-in", "2026-10-13T10:00:00-03:00", "2026-09-26T14:55:00.000Z")];
    const text = { kind: "REPLY" as const, template: undefined };
    expect(evaluateAsOf(whatsapp({ history, trigger: undefined }, { ...text, simulated: false })).outcome).toBe("ALLOW");
    expect(evaluateAsOf(whatsapp({ history, trigger: undefined }, { ...text, simulated: true })).ruleIds).toEqual(["CP-WA-24H"]);
  });

  it("does not re-check what only exists at send time, and skips what it cannot rebuild", () => {
    const decision = evaluateAsOf(email({ history: undefined }));
    const results = Object.fromEntries(decision.evaluated.map((entry) => [entry.ruleId, entry.result]));
    expect(decision.outcome).toBe("ALLOW");
    expect(results).toMatchObject({ "CP-RECIPIENT-FENCE": "SKIP", "CP-ONE-PER-DAY": "SKIP", "CP-NO-SENSITIVE-ASK": "SKIP", "CP-NO-FOREIGN-LINKS": "SKIP" });
    expect(evaluateAsOf(whatsapp({ holidays: undefined })).evaluated.find((entry) => entry.ruleId === "CP-HOURS-AR")?.result).toBe("SKIP");
    expect(evaluateAsOf(whatsapp({ importer: { phoneE164: "+5491155500199" } })).ruleIds).toEqual(["CP-RECIPIENT-FENCE"]);
  });

  it("in exhaustive mode lists every rule the send breached", () => {
    const decision = evaluateAsOf(whatsapp({ operation: approvedAt(BEFORE) }, { kind: "REMINDER", channel: "CONSOLE" }), { exhaustive: true });
    expect(decision.ruleIds).toEqual(["CP-KIND-CHANNEL", "CP-APPROVED-SCOPE"]);
    const late = evaluateAsOf(whatsapp({ consent: consentRevokedAt(BEFORE) }, { sentAtSim: "2026-10-15T21:00:00-03:00" }), { exhaustive: true });
    expect(late).toMatchObject({ outcome: "DENY", ruleIds: ["CP-OPTOUT", "CP-HOURS-AR"] });
  });

  it("never reads the machine's clock", () => {
    const facts = [whatsapp(), whatsapp({}, { sentAtSim: "2026-10-12T10:00:00-03:00" }), email({ contact: contactBouncedAt(BEFORE) })];
    const before = facts.map((entry) => evaluateAsOf(entry));
    vi.useFakeTimers({ now: new Date("2031-03-01T03:00:00.000Z") });
    expect(facts.map((entry) => evaluateAsOf(entry))).toEqual(before);
  });
});
