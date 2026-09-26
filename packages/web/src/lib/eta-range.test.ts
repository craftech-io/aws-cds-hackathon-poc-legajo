import { describe, expect, it } from "vitest";
import { calendarDateOf, etaInRange } from "./eta-range";

describe("ETA range of the scope bar", () => {
  it("compares the ETA's calendar date in Argentina, both ends included", () => {
    const eta = "2026-10-22T08:00:00-03:00";
    expect(etaInRange(eta, {})).toBe(true);
    expect(etaInRange(eta, { from: "2026-10-22", to: "2026-10-22" })).toBe(true);
    expect(etaInRange(eta, { from: "2026-10-23" })).toBe(false);
    expect(etaInRange(eta, { to: "2026-10-21" })).toBe(false);
  });

  it("uses the Argentine date, not the UTC one, near midnight", () => {
    expect(calendarDateOf("2026-10-20T01:30:00Z")).toBe("2026-10-19");
    expect(etaInRange("2026-10-20T01:30:00Z", { from: "2026-10-20" })).toBe(false);
  });
});
