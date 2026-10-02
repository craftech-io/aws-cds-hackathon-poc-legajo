import { describe, expect, it } from "vitest";
import { AR_TIME_ZONE, formatDateTime, formatDayMonth, formatNumber, formatReaderValue, formatSimDateTime, formatTime, minutesBetween, wallClockOf } from "./format";

describe("simulated time as the shell shows it (Argentina)", () => {
  it("reads the story's start and the supplier's deferred email in Argentine time", () => {
    expect(formatSimDateTime("2026-10-14T10:30:00-03:00")).toBe("mié 14/10 10:30");
    expect(formatSimDateTime("2026-10-16T01:00:00Z")).toBe("jue 15/10 22:00");
    expect(formatSimDateTime(new Date("2026-10-18T12:00:00Z"))).toBe("dom 18/10 09:00");
  });

  it("formats the pieces without depending on the browser's zone", () => {
    expect(formatTime("2026-10-15T13:00:00Z")).toBe("10:00");
    expect(formatDayMonth("2026-10-22T11:00:00Z")).toBe("22/10");
    expect(formatDateTime("2026-10-22T11:00:00Z")).toBe("22/10/2026 08:00");
    expect(wallClockOf("2026-10-16T01:00:00Z", AR_TIME_ZONE)).toEqual({ year: 2026, month: 10, day: 15, hour: 22, minute: 0, second: 0, weekday: 4 });
  });

  it("reads a supplier's deadline in the supplier's own zone", () => {
    expect(formatSimDateTime("2026-10-16T01:00:00Z", "Asia/Shanghai")).toBe("vie 16/10 09:00");
    expect(formatTime("2026-10-13T12:20:00Z", "Europe/Rome")).toBe("14:20");
  });

  it("refuses something that is not an instant", () => {
    expect(() => formatTime("mañana")).toThrow(RangeError);
  });
});

describe("numbers and elapsed minutes", () => {
  it("groups thousands with a dot and uses a decimal comma (es-AR)", () => {
    expect(formatNumber(12_480)).toBe("12.480");
    expect(formatNumber(12_840.5, 1)).toBe("12.840,5");
    expect(formatNumber(-1_234_567)).toBe("-1.234.567");
    expect(formatNumber(95)).toBe("95");
    expect(formatNumber(-0.01, 1)).toBe("0,0");
  });

  it("counts whole minutes and never goes negative", () => {
    expect(minutesBetween(0, 125_000)).toBe(2);
    expect(minutesBetween(10_000, 0)).toBe(0);
  });
});

describe("formatReaderValue", () => {
  it("writes the reader's numbers in es-AR notation, with their unit", () => {
    expect(formatReaderValue("12,840 kg")).toBe("12.840 kg");
    expect(formatReaderValue("12,480 kg")).toBe("12.480 kg");
    expect(formatReaderValue("12840")).toBe("12.840");
    expect(formatReaderValue("1,234.5 kg")).toBe("1.234,5 kg");
    expect(formatReaderValue("245")).toBe("245");
  });

  it("leaves words, names and codes as the reader wrote them", () => {
    for (const raw of ["not signed", "Republic of Korea", "GEP-24-0981", "FOB", "12,84"]) expect(formatReaderValue(raw)).toBe(raw);
  });
});
