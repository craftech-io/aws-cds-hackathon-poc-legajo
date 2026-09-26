import { describe, expect, it } from "vitest";
import { ClockDetail, clockDetailOf, commandRequest } from "./clock-api";
import { MAX_ADVANCE_MS, controlGate, dispatchChoice, eventRows, isValidAdvanceTarget, modeText, resetGate, shiftEta, timerLabel } from "./clock-model";
import { clockCopy } from "./copy";

const NOW = Date.parse("2026-10-15T13:05:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function detail(overrides: Record<string, unknown> = {}): ClockDetail {
  return ClockDetail.parse({
    clockId: "JUDGE#firm-judge-01",
    mode: "PAUSED",
    simNow: "2026-10-14T10:30:00-03:00",
    runningUntilReal: null,
    busy: false,
    pending: [],
    startAtSim: "2026-10-14T10:30:00-03:00",
    worldEpoch: 1,
    nextEvents: [],
    reset: { allowed: true },
    ...overrides,
  });
}

describe("clock.get at the edge of the clock view", () => {
  it("reads the next events, the epoch and the reset window next to what the shell reads", () => {
    const parsed = detail({
      nextEvents: [{ operationId: "op-4471", operationNumber: "4471", kind: "MILESTONE", timerId: "DOCS_REQUEST", dueAtSim: "2026-10-15T10:00:00-03:00" }],
    });
    expect(parsed.nextEvents).toHaveLength(1);
    expect(parsed.worldEpoch).toBe(1);
    expect(clockDetailOf({ ...parsed, nextEvents: [{ kind: "LUNCH" }] })).toBeUndefined();
    expect(clockDetailOf(undefined)).toBeUndefined();
  });

  it("defaults the next events to none when an older BFF leaves them out", () => {
    const { nextEvents: _omitted, ...rest } = detail();
    expect(clockDetailOf(rest)?.nextEvents).toEqual([]);
  });
});

describe("next events", () => {
  it("lists every kind of timer in the order it falls, named for the firm", () => {
    const rows = eventRows(
      detail({
        nextEvents: [
          { operationId: "op-4471", operationNumber: "4471", kind: "SIM_REPLY", timerId: "sr-1", dueAtSim: "2026-10-15T22:10:00-03:00" },
          { operationId: "op-4471", operationNumber: "4471", kind: "DEFERRED_SEND", timerId: "ds-1", dueAtSim: "2026-10-15T22:00:00-03:00", reason: "CP-HOURS-SUPPLIER" },
          { operationId: "op-4474", operationNumber: "4474", kind: "MILESTONE", timerId: "DOCS_REQUEST", dueAtSim: "2026-10-17T10:00:00-03:00" },
        ],
      }),
    );
    expect(rows.map((row) => row.label)).toEqual(["Envío diferido", "Respuesta del proveedor simulado", "Hito · Primer pedido (ETA − 7 días)"]);
    expect(rows[0]).toMatchObject({ operationNumber: "4471", whenText: "jue 15/10 22:00", reason: "CP-HOURS-SUPPLIER" });
  });

  it("names a milestone it does not know by its kind only", () => {
    expect(timerLabel({ kind: "MILESTONE", timerId: "SOMETHING_ELSE" })).toBe("Hito");
    expect(timerLabel({ kind: "READER_RETRY", timerId: "rr-1" })).toBe("Reintento del lector documental");
  });
});

describe("busy gate of the time controls (docs/architecture.md §8)", () => {
  it("opens the controls in a quiet world", () => {
    expect(controlGate(detail(), NOW)).toEqual({ disabled: false, force: false, reason: undefined });
  });

  it("closes them while the world waits, saying for what", () => {
    const gate = controlGate(detail({ busy: true, pending: [{ kind: "MAIL", operationNumber: "4471", sinceReal: ago(60_000) }] }), NOW);
    expect(gate.disabled).toBe(true);
    expect(gate.force).toBe(false);
    expect(gate.reason).toContain("email en tránsito por SES");
  });

  it("opens them with force only after five real minutes of the oldest pending", () => {
    const gate = controlGate(detail({ busy: true, pending: [{ kind: "EVENT", sinceReal: ago(5 * 60_000 + 1) }] }), NOW);
    expect(gate).toEqual({ disabled: false, force: true, reason: clockCopy.gate.force });
  });

  it("keeps them closed until the first answer of the clock", () => {
    expect(controlGate(undefined, NOW).disabled).toBe(true);
  });
});

describe("advance to an hour", () => {
  it("accepts a later hour within 14 days and refuses going back or too far", () => {
    const simNow = "2026-10-14T10:30:00-03:00";
    expect(isValidAdvanceTarget(simNow, "2026-10-15T10:00:00-03:00")).toBe(true);
    expect(isValidAdvanceTarget(simNow, simNow)).toBe(false);
    expect(isValidAdvanceTarget(simNow, "2026-10-13T10:00:00-03:00")).toBe(false);
    expect(isValidAdvanceTarget(simNow, new Date(Date.parse(simNow) + MAX_ADVANCE_MS + 60_000).toISOString())).toBe(false);
    expect(isValidAdvanceTarget(simNow, undefined)).toBe(false);
  });
});

describe("commands of the clock view", () => {
  it("sends force only on the commands the busy gate closes", () => {
    expect(commandRequest({ kind: "advanceTo", toSim: "2026-10-15T10:00:00-03:00" }, true)).toEqual({ path: "clock.advanceTo", input: { toSim: "2026-10-15T10:00:00-03:00", force: true } });
    expect(commandRequest({ kind: "moveEta", operationId: "op-4471", eta: "2026-10-20T08:00:00-03:00" })).toEqual({
      path: "clock.moveEta",
      input: { operationId: "op-4471", eta: "2026-10-20T08:00:00-03:00" },
    });
    expect(commandRequest({ kind: "setRunning", running: true }, true)).toEqual({ path: "clock.setRunning", input: { running: true } });
    expect(commandRequest({ kind: "reset" }, true)).toEqual({ path: "clock.reset", input: {} });
    expect(commandRequest({ kind: "emitDispatchStatus", operationId: "op-4487", ...dispatchChoice("CANAL_ASIGNADO#NARANJA") })).toEqual({
      path: "clock.emitDispatchStatus",
      input: { operationId: "op-4487", status: "CANAL_ASIGNADO", channel: "NARANJA" },
    });
    expect(commandRequest({ kind: "fireMilestone", operationId: "op-4471", milestone: "FOLLOWUP" })).toMatchObject({ path: "clock.fireMilestone", input: { milestone: "FOLLOWUP" } });
  });

  it("refuses to send a malformed hour", () => {
    expect(() => commandRequest({ kind: "advanceTo", toSim: "mañana" })).toThrow();
  });

  it("moves an ETA by whole days in Argentina's offset", () => {
    expect(shiftEta("2026-10-22T08:00:00-03:00", -2)).toBe("2026-10-20T08:00:00-03:00");
    expect(shiftEta("2026-10-22T11:00:00.000Z", 4)).toBe("2026-10-26T08:00:00-03:00");
    expect(dispatchChoice("LIBERADO")).toEqual({ status: "LIBERADO" });
  });
});

describe("who may reset the world and when", () => {
  it("lets a broker or a judge reset, never an analyst", () => {
    expect(resetGate(detail(), "BROKER")).toEqual({ allowed: true });
    expect(resetGate(detail(), "JUDGE")).toEqual({ allowed: true });
    expect(resetGate(detail(), "ANALYST")).toEqual({ allowed: false, reason: clockCopy.reset.onlyApprovers });
  });

  it("says when the next reset opens (once every 10 minutes per world)", () => {
    const gate = resetGate(detail({ reset: { allowed: false, nextAllowedAtReal: "2026-10-15T13:12:00Z" } }), "JUDGE");
    expect(gate).toEqual({ allowed: false, reason: clockCopy.reset.wait("10:12") });
  });
});

describe("mode of the world", () => {
  it("reads paused or live until the real hour it falls back", () => {
    expect(modeText(detail())).toBe("En pausa");
    expect(modeText(detail({ mode: "RUNNING", runningUntilReal: "2026-10-15T13:35:00Z" }))).toBe("En vivo hasta las 10:35");
  });
});
