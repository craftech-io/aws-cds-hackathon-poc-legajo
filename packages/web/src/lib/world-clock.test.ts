import { describe, expect, it } from "vitest";
import {
  ClockSnapshot,
  FORCE_AFTER_MS,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  POLL_BUSY_MS,
  POLL_IDLE_MS,
  canForce,
  forceAvailableInMs,
  isBusy,
  moveRequest,
  oldestPendingAgeMs,
  pollDelayMs,
  waitText,
} from "./world-clock";

const NOW = Date.parse("2026-10-15T13:05:00Z");

function snapshot(overrides: Partial<ClockSnapshot> = {}): ClockSnapshot {
  return ClockSnapshot.parse({
    clockId: "JUDGE#firm-judge-01",
    mode: "PAUSED",
    simNow: "2026-10-14T10:30:00-03:00",
    busy: false,
    pending: [],
    ...overrides,
  });
}

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("clock.get at the edge", () => {
  it("accepts the answer with extra fields and refuses a malformed one", () => {
    const parsed = ClockSnapshot.parse({ ...snapshot(), worldEpoch: 3, next: [{ timerKind: "MILESTONE" }] });
    expect(parsed).toMatchObject({ mode: "PAUSED", worldEpoch: 3 });
    expect(ClockSnapshot.safeParse({ ...snapshot(), mode: "STOPPED" }).success).toBe(false);
    expect(ClockSnapshot.safeParse({ ...snapshot(), simNow: "mañana" }).success).toBe(false);
    expect(ClockSnapshot.safeParse({ ...snapshot(), pending: [{ kind: "LUNCH", sinceReal: ago(0) }] }).success).toBe(false);
  });
});

describe("refresh cadence (docs/architecture.md §10)", () => {
  it("asks every 3 s while something is in flight or the clock runs live, every 15 s at rest", () => {
    expect(pollDelayMs(snapshot())).toBe(POLL_IDLE_MS);
    expect(pollDelayMs(snapshot({ busy: true }))).toBe(POLL_BUSY_MS);
    expect(pollDelayMs(snapshot({ pending: [{ kind: "MAIL", sinceReal: ago(1_000) }] }))).toBe(POLL_BUSY_MS);
    expect(pollDelayMs(snapshot({ mode: "RUNNING", runningUntilReal: ago(-60_000) }))).toBe(POLL_BUSY_MS);
    expect(pollDelayMs(undefined)).toBe(POLL_IDLE_MS);
    expect([POLL_BUSY_MS, POLL_IDLE_MS]).toEqual([3_000, 15_000]);
  });
});

describe("busy world and 'Avanzar igual'", () => {
  it("counts a pending as busy even if the flag lags behind", () => {
    expect(isBusy(snapshot({ pending: [{ kind: "TURN", operationNumber: "4471", sinceReal: ago(10_000) }] }))).toBe(true);
    expect(isBusy(snapshot())).toBe(false);
  });

  it("offers forcing only once the oldest pending is five real minutes old", () => {
    const young = snapshot({ busy: true, pending: [{ kind: "MAIL", sinceReal: ago(FORCE_AFTER_MS - 1_000) }] });
    expect(canForce(young, NOW)).toBe(false);
    expect(forceAvailableInMs(young, NOW)).toBe(1_000);
    const old = snapshot({ busy: true, pending: [{ kind: "TURN", sinceReal: ago(30_000) }, { kind: "MAIL", sinceReal: ago(FORCE_AFTER_MS) }] });
    expect(oldestPendingAgeMs(old, NOW)).toBe(FORCE_AFTER_MS);
    expect(canForce(old, NOW)).toBe(true);
    expect(forceAvailableInMs(old, NOW)).toBeUndefined();
    expect(canForce(snapshot(), NOW)).toBe(false);
  });

  it("says what the world waits for, the oldest first, with the operation and how many more", () => {
    const busy = snapshot({
      busy: true,
      pending: [
        { kind: "TURN", operationNumber: "4471", sinceReal: ago(5_000) },
        { kind: "MAIL", operationNumber: "4471", sinceReal: ago(40_000) },
      ],
    });
    expect(waitText(busy)).toBe("Esperando: email en tránsito por SES (~30 s) · operación 4471 · y 1 pendiente más");
    expect(waitText(snapshot({ busy: true, pending: [{ kind: "TURN", sinceReal: ago(1_000) }] }))).toBe("El agente está escribiendo… (~1 min)");
    expect(waitText(snapshot({ busy: true }))).toBe("Los controles del reloj se habilitan cuando termina lo que está en curso.");
    expect(waitText(snapshot())).toBeUndefined();
  });
});

describe("moves of the clock (docs/tool-catalog.md, clock router)", () => {
  it("maps the three buttons and the forced move to their procedures", () => {
    expect(moveRequest({ kind: "next" }, false)).toEqual({ path: "clock.advanceToNext", input: {} });
    expect(moveRequest({ kind: "next" }, true)).toEqual({ path: "clock.advanceToNext", input: { force: true } });
    expect(moveRequest({ kind: "by", minutes: MINUTES_PER_HOUR }, false)).toEqual({ path: "clock.advance", input: { minutes: 60 } });
    expect(moveRequest({ kind: "by", minutes: MINUTES_PER_DAY }, false)).toEqual({ path: "clock.advance", input: { minutes: 1_440 } });
  });

  it("refuses a move outside 1 minute to 14 days", () => {
    expect(() => moveRequest({ kind: "by", minutes: 0 }, false)).toThrow(RangeError);
    expect(() => moveRequest({ kind: "by", minutes: 15 * MINUTES_PER_DAY }, false)).toThrow(RangeError);
    expect(() => moveRequest({ kind: "by", minutes: 1.5 }, false)).toThrow(RangeError);
  });
});
