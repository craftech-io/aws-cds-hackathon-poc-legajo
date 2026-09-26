import { describe, expect, it } from "vitest";
import { createLogger } from "../lib/log";
import { EVENT_ID_PATTERN, EventId, channelEvent, countMetric, derivedEventId, turnEventId } from "./adapter";

describe("event ids", () => {
  it("derives evt_ + 26 upper-case Crockford characters from the type and the natural key", () => {
    const id = derivedEventId("INTAKE_DOCUMENT", "<reply-4471-1@sim.legajo.demo.craftech.io>#0");
    expect(id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(derivedEventId("INTAKE_DOCUMENT", "<reply-4471-1@sim.legajo.demo.craftech.io>#0")).toBe(id);
    expect(derivedEventId("INTAKE_DOCUMENT", "<reply-4471-1@sim.legajo.demo.craftech.io>#1")).not.toBe(id);
    expect(derivedEventId("ESCALATE", "<reply-4471-1@sim.legajo.demo.craftech.io>#0")).not.toBe(id);
  });

  it("derives AGENT_TURN ids from <TurnTrigger>#<key>", () => {
    expect(turnEventId("SUPPLIER_EMAIL", "<m@x>")).toBe(derivedEventId("AGENT_TURN", "SUPPLIER_EMAIL#<m@x>"));
    expect(turnEventId("SUPPLIER_EMAIL", "<m@x>")).not.toBe(turnEventId("IMPORTER_MESSAGE", "<m@x>"));
  });

  it("accepts the ids of the QaDriver and nothing else", () => {
    expect(EVENT_ID_PATTERN.test(`qa-${"a".repeat(40)}`)).toBe(true);
    expect(EventId.safeParse("evt_01JAB3C4D5E6F7G8H9J0KMNPQR").success).toBe(true);
    expect(EventId.safeParse("evt_01JAB3C4D5E6F7G8H9J0KMNPQU").success).toBe(false);
    expect(EventId.safeParse("evt_short").success).toBe(false);
    expect(() => derivedEventId("AGENT_TURN", "")).toThrow(RangeError);
  });
});

describe("channel events", () => {
  const base = { operationId: "op-4471", clockId: "GLOBAL#firm-delta", firmId: "firm-delta", eventAtSim: "2026-10-15T22:10:00.000Z" };

  it("validates an event before it leaves the adapter", () => {
    const turn = channelEvent({ type: "AGENT_TURN", eventId: turnEventId("SUPPLIER_EMAIL", "<m@x>"), ...base, trigger: "SUPPLIER_EMAIL", messageId: "msg-abc" });
    expect(turn).toMatchObject({ type: "AGENT_TURN", trigger: "SUPPLIER_EMAIL", intakeEventIds: [] });
    expect(() => channelEvent({ type: "AGENT_TURN", eventId: "evt_bad", ...base, trigger: "SUPPLIER_EMAIL" })).toThrow();
    expect(() => channelEvent({ type: "ESCALATE", eventId: derivedEventId("ESCALATE", "k"), ...base, reason: "SOMETHING_ELSE" as "OTHER" })).toThrow();
  });

  it("refuses an intake larger than 10 MB or without its object", () => {
    const intake = {
      type: "INTAKE_DOCUMENT" as const,
      eventId: derivedEventId("INTAKE_DOCUMENT", "k#0"),
      ...base,
      source: { party: "SUPPLIER" as const, channel: "EMAIL" as const },
      object: { store: "INBOUND_MAIL" as const, key: "poc/ops/abc", attachmentIndex: 0 },
      sha256: "a".repeat(64),
      sizeBytes: 10 * 1024 * 1024 + 1,
    };
    expect(() => channelEvent(intake)).toThrow();
    expect(channelEvent({ ...intake, sizeBytes: 1024 }).type).toBe("INTAKE_DOCUMENT");
  });

  it("counts a metric with one log line that names it", () => {
    const lines: string[] = [];
    countMetric(createLogger({ sink: (line) => lines.push(line), level: "debug" }), "ThreadAddressInvalid", { reason: "THREAD_ADDRESS_UNKNOWN" });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ level: "warn", metric: "ThreadAddressInvalid", reason: "THREAD_ADDRESS_UNKNOWN" });
  });
});
