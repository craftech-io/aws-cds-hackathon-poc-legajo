import { describe, expect, it } from "vitest";
import { fixedClock } from "../lib/clock";
import {
  ARGENTINA_TIME_ZONE,
  argentinaBusinessHours,
  atLocalTime,
  businessHours,
  isBusinessOpen,
  isValidTimeZone,
  localDateOf,
  nextBusinessOpening,
  supplierBusinessHours,
  toZonedIso,
  zonedInstant,
  zonedParts,
} from "./business-hours";
import { NO_HOLIDAYS, createHolidayProvider, holidayCalendar } from "./holidays";

const at = (iso: string): Date => new Date(iso);
const iso = (date: Date): string => date.toISOString();

// docs/seed-spec.md §12: national holidays of October to December 2026.
const AR_HOLIDAYS = holidayCalendar("AR", ["2026-10-12", "2026-11-23", "2026-12-08", "2026-12-25"]);
const AR = argentinaBusinessHours(AR_HOLIDAYS);
const QINGDAO = supplierBusinessHours("Asia/Shanghai");

describe("wall clock by zone", () => {
  it("reads the local date, time, weekday and offset of an instant", () => {
    expect(zonedParts(at("2026-10-15T13:00:00Z"), ARGENTINA_TIME_ZONE)).toEqual({ date: "2026-10-15", time: "10:00", hour: 10, minute: 0, second: 0, weekday: "THU", offsetMinutes: -180 });
    expect(zonedParts(at("2026-10-15T13:05:00Z"), "Asia/Shanghai")).toMatchObject({ date: "2026-10-15", time: "21:05", offsetMinutes: 480 });
    expect(zonedParts(at("2026-10-15T20:00:00Z"), "Asia/Kolkata")).toMatchObject({ date: "2026-10-16", time: "01:30", weekday: "FRI", offsetMinutes: 330 });
    expect(localDateOf(at("2026-10-16T02:30:00Z"), ARGENTINA_TIME_ZONE)).toBe("2026-10-15");
  });

  it("prints ISO 8601 with the zone's offset, including daylight saving time", () => {
    expect(toZonedIso(at("2026-10-16T01:00:00Z"), "Asia/Shanghai")).toBe("2026-10-16T09:00:00+08:00");
    expect(toZonedIso(at("2026-10-15T13:00:00Z"), ARGENTINA_TIME_ZONE)).toBe("2026-10-15T10:00:00-03:00");
    expect(toZonedIso(at("2026-10-23T15:30:00Z"), "Europe/Berlin")).toBe("2026-10-23T17:30:00+02:00");
    expect(toZonedIso(at("2026-10-26T08:00:00Z"), "Europe/Berlin")).toBe("2026-10-26T09:00:00+01:00");
    expect(toZonedIso(at("2026-10-15T12:00:00Z"), "Asia/Kolkata")).toBe("2026-10-15T17:30:00+05:30");
  });

  it("turns a local date and time into an instant, across daylight saving changes", () => {
    expect(iso(zonedInstant("2026-10-16", "09:00", "Asia/Shanghai"))).toBe("2026-10-16T01:00:00.000Z");
    expect(iso(zonedInstant("2026-10-24", "09:00", "Europe/Berlin"))).toBe("2026-10-24T07:00:00.000Z");
    expect(iso(zonedInstant("2026-10-26", "09:00", "Europe/Berlin"))).toBe("2026-10-26T08:00:00.000Z");
    // Skipped hour (spring forward): lands after the gap.
    expect(toZonedIso(zonedInstant("2026-03-29", "02:30", "Europe/Berlin"), "Europe/Berlin")).toBe("2026-03-29T03:30:00+02:00");
    // Repeated hour (fall back): the second occurrence.
    expect(toZonedIso(zonedInstant("2026-10-25", "02:30", "Europe/Berlin"), "Europe/Berlin")).toBe("2026-10-25T02:30:00+01:00");
  });

  it("computes milestones and deadlines of operation 4471 from its ETA", () => {
    const eta = at("2026-10-22T11:00:00Z"); // 22/10 08:00 in Buenos Aires
    expect(iso(atLocalTime(eta, -7, "10:00", ARGENTINA_TIME_ZONE))).toBe("2026-10-15T13:00:00.000Z"); // DOCS_REQUEST
    expect(iso(atLocalTime(eta, -3, "10:00", ARGENTINA_TIME_ZONE))).toBe("2026-10-19T13:00:00.000Z"); // FOLLOWUP_FINAL
    // Supplier deadline: ETA − 4 days at 17:00 in Qingdao (docs/tool-catalog.md, get_dossier).
    expect(toZonedIso(atLocalTime(eta, -4, "17:00", "Asia/Shanghai"), "Asia/Shanghai")).toBe("2026-10-18T17:00:00+08:00");
    expect(() => atLocalTime(eta, 1.5, "10:00", ARGENTINA_TIME_ZONE)).toThrow(RangeError);
  });

  it("rejects unknown zones, malformed times and invalid instants", () => {
    expect(isValidTimeZone("Asia/Ho_Chi_Minh")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(() => supplierBusinessHours("Mars/Olympus_Mons")).toThrow();
    expect(() => zonedInstant("2026-10-16", "9:00", "Asia/Shanghai")).toThrow();
    expect(() => businessHours("Asia/Shanghai", { open: "18:00", close: "09:00" })).toThrow(RangeError);
    expect(() => zonedParts(new Date(Number.NaN), "Asia/Shanghai")).toThrow(RangeError);
  });
});

describe("business hours in Argentina (CP-HOURS-AR)", () => {
  it("is open Monday to Friday from 09:00 until just before 18:00", () => {
    expect(isBusinessOpen(at("2026-10-15T12:00:00Z"), AR)).toBe(true); // Thu 09:00
    expect(isBusinessOpen(at("2026-10-15T11:59:59Z"), AR)).toBe(false); // Thu 08:59:59
    expect(isBusinessOpen(at("2026-10-15T20:59:59Z"), AR)).toBe(true); // Thu 17:59:59
    expect(isBusinessOpen(at("2026-10-15T21:00:00Z"), AR)).toBe(false); // Thu 18:00
    expect(isBusinessOpen(at("2026-10-17T15:00:00Z"), AR)).toBe(false); // Sat 12:00
  });

  it("defers an evening message to 09:00 of the next business day", () => {
    expect(iso(nextBusinessOpening(at("2026-10-15T23:00:00Z"), AR))).toBe("2026-10-16T12:00:00.000Z"); // Thu 20:00 → Fri 09:00
    expect(iso(nextBusinessOpening(at("2026-10-16T01:10:00Z"), AR))).toBe("2026-10-16T12:00:00.000Z"); // Thu 22:10 → Fri 09:00
    expect(iso(nextBusinessOpening(at("2026-10-16T21:00:00Z"), AR))).toBe("2026-10-19T12:00:00.000Z"); // Fri 18:00 → Mon 09:00
    expect(iso(nextBusinessOpening(at("2026-10-15T10:00:00Z"), AR))).toBe("2026-10-15T12:00:00.000Z"); // Thu 07:00 → Thu 09:00
    const open = at("2026-10-15T14:17:00Z");
    expect(nextBusinessOpening(open, AR)).toEqual(open);
  });

  it("is closed on a national holiday: the milestone of Monday 12/10 goes out on Tuesday 13/10 09:00", () => {
    const milestone = at("2026-10-12T13:00:00Z"); // Mon 12/10 10:00
    expect(isBusinessOpen(milestone, AR)).toBe(false);
    expect(iso(nextBusinessOpening(milestone, AR))).toBe("2026-10-13T12:00:00.000Z");
    expect(isBusinessOpen(milestone, argentinaBusinessHours(NO_HOLIDAYS))).toBe(true);
    expect(iso(nextBusinessOpening(at("2026-12-24T22:00:00Z"), AR))).toBe("2026-12-28T12:00:00.000Z"); // Thu 24/12 19:00 → Mon 28/12
  });
});

describe("business hours of the supplier (CP-HOURS-SUPPLIER)", () => {
  it("defers the email of operation 4471 to 09:00 in Qingdao, 22:00 in Buenos Aires", () => {
    const sent = at("2026-10-15T13:05:00Z"); // 10:05 AR, 21:05 in Qingdao
    expect(isBusinessOpen(sent, QINGDAO)).toBe(false);
    const deferred = nextBusinessOpening(sent, QINGDAO);
    expect(toZonedIso(deferred, "Asia/Shanghai")).toBe("2026-10-16T09:00:00+08:00");
    expect(toZonedIso(deferred, ARGENTINA_TIME_ZONE)).toBe("2026-10-15T22:00:00-03:00");
    expect(isBusinessOpen(at("2026-10-16T01:10:00Z"), QINGDAO)).toBe(true); // the correction at 09:10 Qingdao goes out
  });

  it("follows the supplier's daylight saving time and ignores Argentine holidays", () => {
    const berlin = supplierBusinessHours("Europe/Berlin");
    expect(isBusinessOpen(at("2026-10-23T15:30:00Z"), berlin)).toBe(true); // Fri 17:30 CEST
    expect(iso(nextBusinessOpening(at("2026-10-23T16:00:00Z"), berlin))).toBe("2026-10-26T08:00:00.000Z"); // Mon 09:00 CET
    expect(isBusinessOpen(at("2026-10-12T08:00:00Z"), berlin)).toBe(true); // Argentine holiday, 10:00 in Berlin
  });

  it("supports a custom schedule", () => {
    const saturdayMornings = businessHours("America/Sao_Paulo", { days: ["SAT"], open: "08:00", close: "12:00" });
    expect(iso(nextBusinessOpening(at("2026-10-15T15:00:00Z"), saturdayMornings))).toBe("2026-10-17T11:00:00.000Z");
  });
});

describe("holiday calendars", () => {
  it("dedupe and sort dates and validate rows", () => {
    const calendar = holidayCalendar("AR", [{ date: "2026-12-25", name: "Navidad" }, "2026-10-12", "2026-10-12"]);
    expect(calendar.dates()).toEqual(["2026-10-12", "2026-12-25"]);
    expect(calendar.has("2026-10-12")).toBe(true);
    expect(calendar.has("2026-10-13")).toBe(false);
    expect(() => holidayCalendar("AR", ["12/10/2026"])).toThrow();
  });

  it("are loaded once per TTL of real time and fail on a malformed row", async () => {
    let reads = 0;
    let now = Date.parse("2026-11-02T15:00:00Z");
    const provider = createHolidayProvider(
      async () => {
        reads += 1;
        return [{ date: "2026-10-12", verified: false, pk: "REF#HOLIDAY#AR" }];
      },
      { ttlMs: 60_000, realClock: { now: async () => new Date(now) } },
    );
    expect((await provider("AR")).dates()).toEqual(["2026-10-12"]);
    await provider("AR");
    expect(reads).toBe(1);
    now += 60_000;
    await provider("AR");
    expect(reads).toBe(2);
    const broken = createHolidayProvider(async () => [{ date: "2026-13-01" }], { realClock: fixedClock("2026-11-02T15:00:00Z") });
    await expect(broken("AR")).rejects.toThrow();
  });
});
