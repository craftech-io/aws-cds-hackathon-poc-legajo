import { describe, expect, it } from "vitest";
import { isoToLocalInput, isoWithOffset, localInputToIso, offsetMinutesOf, splitLocalDateTime, zonedToInstant } from "./local-datetime";

describe("datetime-local inputs read in a zone, never in the browser's", () => {
  it("reads the input as Argentine time by default and as the supplier's when asked", () => {
    expect(localInputToIso("2026-10-15T10:00")).toBe("2026-10-15T10:00:00-03:00");
    expect(localInputToIso("2026-10-16T09:00", "Asia/Shanghai")).toBe("2026-10-16T09:00:00+08:00");
    expect(localInputToIso("2026-10-13T14:20", "Europe/Rome")).toBe("2026-10-13T14:20:00+02:00");
  });

  it("refuses incomplete, impossible and non-existent wall times", () => {
    expect(splitLocalDateTime("2026-10-10")).toBeUndefined();
    expect(localInputToIso("")).toBeUndefined();
    expect(localInputToIso("2026-13-40T25:00")).toBeUndefined();
    // 02:30 does not exist in Rome on the morning clocks move forward.
    expect(zonedToInstant("2027-03-28", "02:30", "Europe/Rome")).toBeUndefined();
  });

  it("round-trips an instant to the input value", () => {
    expect(isoToLocalInput("2026-10-16T01:00:00Z")).toBe("2026-10-15T22:00");
    expect(isoToLocalInput("2026-10-16T01:00:00Z", "Asia/Shanghai")).toBe("2026-10-16T09:00");
    expect(localInputToIso(isoToLocalInput("2026-10-22T11:00:00Z"))).toBe("2026-10-22T08:00:00-03:00");
  });

  it("writes the offset of the zone at that instant", () => {
    expect(offsetMinutesOf(new Date("2026-10-15T13:00:00Z"), "America/Argentina/Buenos_Aires")).toBe(-180);
    expect(offsetMinutesOf(new Date("2026-01-15T13:00:00Z"), "Europe/Rome")).toBe(60);
    expect(isoWithOffset("2026-10-15T13:00:00Z")).toBe("2026-10-15T10:00:00-03:00");
  });
});
