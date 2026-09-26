import { describe, expect, it } from "vitest";
import type { WorldPending } from "../../lib/world-clock";
import { MAX_ADVANCE_MINUTES, advanceStepTo, mergeTimeline, pendingReasonOf, pendingTimers, worldPendingsOf } from "./timeline-model";
import type { DecisionData, MessageData, TimelineEntryData } from "./types";

function messageEntry(messageId: string, sentAtSim: string, overrides: Partial<MessageData> = {}): TimelineEntryData {
  const message: MessageData = {
    messageId,
    direction: "OUT",
    channel: "WHATSAPP",
    counterpart: "IMPORTER",
    author: "AGENT",
    status: "SENT",
    body: "Operación 4471: faltan documentos.",
    to: "+54*******0101",
    from: "simulated",
    sentAtSim,
    buttons: [],
    attachments: [],
    ...overrides,
  };
  return { type: "MESSAGE", atSim: sentAtSim, message };
}

function decision(decisionId: string, atSim: string | undefined, overrides: Partial<DecisionData> = {}): DecisionData {
  return {
    decisionId,
    ts: atSim ?? "2026-09-26T15:00:00.000Z",
    decision: "ACTION",
    action: "MILESTONE_FIRED",
    ruleIds: [],
    evaluated: [],
    actor: "SYSTEM",
    refs: {},
    atReal: "2026-09-26T15:00:00.000Z",
    ...(atSim === undefined ? {} : { atSim }),
    ...overrides,
  };
}

describe("unified timeline", () => {
  it("orders messages, turn notes, escalations and decisions by simulated time, whatever the offset they carry", () => {
    const entries: TimelineEntryData[] = [
      messageEntry("msg-02", "2026-10-15T13:05:00.000Z", { direction: "IN", author: "IMPORTER", status: "RECEIVED" }),
      messageEntry("msg-01", "2026-10-15T10:00:00-03:00"),
      { type: "NOTE", atSim: "2026-10-15T10:00:30-03:00", turnId: "turn-1", trigger: "MILESTONE", text: "Pedido inicial enviado." },
    ];
    const items = mergeTimeline(entries, [decision("dec-1", "2026-10-15T13:02:00.000Z", { action: "TAKEOVER" })]);
    expect(items.map((item) => item.key)).toEqual(["msg:msg-01", "note:turn-1", "dec:dec-1", "msg:msg-02"]);
  });

  it("leaves out a decision about a message the timeline already shows, and one outside the world's time", () => {
    const entries = [messageEntry("msg-01", "2026-10-15T10:00:00-03:00")];
    const decisions = [
      decision("dec-allow", "2026-10-15T10:00:00-03:00", { decision: "ALLOW", action: "SEND_WHATSAPP", messageId: "msg-01", ruleIds: ["CP-OPTIN"] }),
      decision("dec-deny", "2026-10-15T10:00:00-03:00", { decision: "DENY", action: "SEND_EMAIL", ruleIds: ["CP-SUPPLIER-AUTH"] }),
      decision("dec-console", undefined, { decision: "DENY", action: "CROSS_FIRM" }),
    ];
    expect(mergeTimeline(entries, decisions).map((item) => item.key)).toEqual(["dec:dec-deny", "msg:msg-01"]);
  });

  it("at the same instant shows the decision, then the message, then the escalation it opened, then the turn's note", () => {
    const at = "2026-10-15T22:10:00-03:00";
    const entries: TimelineEntryData[] = [
      { type: "NOTE", atSim: at, turnId: "turn-9", trigger: "DOCUMENT_READ", text: "Pedí la corrección." },
      {
        type: "ESCALATION",
        atSim: at,
        escalation: { escalationId: "esc-1", operationId: "op-4471", operationNumber: "4471", reason: "OTHER", summary: "Revisar", status: "OPEN", openedAtSim: at, openedBy: "AGENT" },
      },
      messageEntry("msg-05", at, { channel: "EMAIL", counterpart: "SUPPLIER", kind: "CORRECTION_REQUEST" }),
    ];
    expect(mergeTimeline(entries, [decision("dec-5", at, { action: "DOCUMENT_READ" })]).map((item) => item.kind)).toEqual(["DECISION", "MESSAGE", "ESCALATION", "NOTE"]);
  });
});

describe("pendings of the operation", () => {
  it("moves the paused clock by whole minutes up to the pending, never more than 14 days", () => {
    expect(advanceStepTo("2026-10-15T10:00:00-03:00", "2026-10-15T22:00:00-03:00")).toEqual({ kind: "minutes", minutes: 720 });
    expect(advanceStepTo("2026-10-15T10:00:30-03:00", "2026-10-15T10:02:00-03:00")).toEqual({ kind: "minutes", minutes: 2 });
    expect(advanceStepTo("2026-10-15T22:00:00-03:00", "2026-10-15T22:00:00-03:00")).toEqual({ kind: "due" });
    expect(advanceStepTo("2026-10-01T10:00:00-03:00", "2026-10-22T08:00:00-03:00")).toEqual({ kind: "tooFar" });
    expect(advanceStepTo("2026-10-08T08:00:00-03:00", "2026-10-22T08:00:00-03:00")).toEqual({ kind: "minutes", minutes: MAX_ADVANCE_MINUTES });
    expect(advanceStepTo(undefined, "2026-10-15T22:00:00-03:00")).toEqual({ kind: "unknown" });
  });

  it("reads the reason of a timer as a rule, a known code or the words of whoever scheduled it", () => {
    expect(pendingReasonOf("CP-HOURS-SUPPLIER")).toEqual({ kind: "rule", ruleId: "CP-HOURS-SUPPLIER" });
    expect(pendingReasonOf("READER_UNAVAILABLE")).toEqual({ kind: "code", code: "READER_UNAVAILABLE" });
    expect(pendingReasonOf("Recordar el certificado")).toEqual({ kind: "text", text: "Recordar el certificado" });
    expect(pendingReasonOf(undefined)).toEqual({ kind: "none" });
    expect(pendingReasonOf(" ")).toEqual({ kind: "none" });
  });

  it("lists the timers by due time, a send deferred by the supplier's hours read in the supplier's zone", () => {
    const items = pendingTimers(
      [
        { kind: "MILESTONE", timerId: "FOLLOWUP", dueAtSim: "2026-10-17T13:00:00.000Z" },
        { kind: "DEFERRED_SEND", timerId: "msg-03", dueAtSim: "2026-10-16T01:00:00.000Z", reason: "CP-HOURS-SUPPLIER" },
        { kind: "DEFERRED_SEND", timerId: "msg-04", dueAtSim: "2026-10-16T12:00:00.000Z", reason: "CP-HOURS-AR" },
      ],
      "2026-10-15T10:00:00-03:00",
    );
    expect(items.map((item) => [item.key, item.zone])).toEqual([
      ["DEFERRED_SEND#msg-03", "SUPPLIER"],
      ["DEFERRED_SEND#msg-04", "ARGENTINA"],
      ["MILESTONE#FOLLOWUP", "ARGENTINA"],
    ]);
    expect(items[0]?.advance).toEqual({ kind: "minutes", minutes: 720 });
  });

  it("keeps only what the world waits for on this operation", () => {
    const pending: WorldPending[] = [
      { kind: "MAIL", operationNumber: "4471", detail: "SIMMAIL", sinceReal: "2026-09-26T15:00:00.000Z" },
      { kind: "TURN", operationNumber: "4478", sinceReal: "2026-09-26T15:00:00.000Z" },
      { kind: "SCAN", sinceReal: "2026-09-26T15:00:00.000Z" },
    ];
    expect(worldPendingsOf(pending, "4471").map((item) => item.kind)).toEqual(["MAIL"]);
  });
});
