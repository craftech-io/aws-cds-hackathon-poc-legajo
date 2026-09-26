import { describe, expect, it } from "vitest";
import { holidayCalendar } from "../services/holidays";
import { evaluate } from "./engine";
import { ARGENTINA_HOLIDAYS, sentToImporter, toImporter, toSupplier } from "./testing";

describe("[FL-056] national holidays of Argentina", () => {
  it("[FL-056] the DOCS_REQUEST milestone on Monday 12/10 (holiday) goes out on Tuesday 13/10 at 09:00", () => {
    const decision = evaluate(toImporter({ at: "2026-10-12T10:00:00-03:00" }));
    expect(decision).toMatchObject({ outcome: "DEFER", ruleIds: ["CP-HOURS-AR"], nextAllowedAt: "2026-10-13T09:00:00-03:00" });
    expect(decision.reason).toBe("MON 12/10 10:00 (holiday) is outside Buenos Aires (America/Argentina/Buenos_Aires) business hours: deferred to 2026-10-13T09:00:00-03:00");
    expect(evaluate(toImporter({ at: "2026-10-13T09:00:00-03:00" })).outcome).toBe("ALLOW");
  });

  it("[FL-056] a Friday evening before a Monday holiday waits for Tuesday", () => {
    // 23/11/2026 is the Monday the 20/11 holiday moves to.
    expect(evaluate(toImporter({ at: "2026-11-20T18:30:00-03:00" })).nextAllowedAt).toBe("2026-11-24T09:00:00-03:00");
  });

  it("[FL-056] reads the calendar either as dates or as the calendar of services/holidays.ts", () => {
    const calendar = holidayCalendar("AR", ARGENTINA_HOLIDAYS.map((date) => ({ date, verified: false })));
    const at = "2026-12-08T11:00:00-03:00";
    expect(evaluate(toImporter({ at, holidays: calendar }))).toEqual(evaluate(toImporter({ at })));
    expect(evaluate(toImporter({ at, holidays: [] })).outcome).toBe("ALLOW");
  });

  it("[FL-056] a deferral skips the holiday even when the daily cap moved it first", () => {
    // Friday 09/10: a reminder already went out, and Monday 12/10 is a holiday.
    const decision = evaluate(toImporter({ at: "2026-10-09T15:00:00-03:00", message: { kind: "REMINDER", template: { name: "legajo_recordatorio", params: ["4471"] } }, history: [sentToImporter("msg-01", "DOCS_REQUEST", "2026-10-09T10:00:00-03:00")] }));
    expect(decision).toMatchObject({ outcome: "DEFER", ruleIds: ["CP-ONE-PER-DAY"], nextAllowedAt: "2026-10-13T09:00:00-03:00" });
  });

  it("[FL-056] Argentina's holidays never close the supplier's hours", () => {
    const madrid = { supplierId: "sup-qingdao", timezone: "Europe/Madrid" };
    expect(evaluate(toSupplier({ supplier: madrid, at: "2026-10-12T10:00:00+02:00" })).outcome).toBe("ALLOW");
  });
});
