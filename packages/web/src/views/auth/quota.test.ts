import { GUEST_QUOTAS, windowEnd } from "@legajo/shared/guest-limits";
import { describe, expect, it } from "vitest";
import { AUTH_COPY } from "./copy";
import { isDailyReset, localTime, quotaMessage, quotaOfRefusal, usageLines } from "./quota";

const es = AUTH_COPY.es;
const en = AUTH_COPY.en;

describe("[FL-111] usage limits of a guest world", () => {
  it("[FL-111] reads QUOTA_EXCEEDED {kind, resetsAtReal} from the error's data", () => {
    expect(quotaOfRefusal({ quota: { kind: "CLOCK_MOVES", resetsAtReal: "2026-10-15T00:00:00.000Z" } })).toEqual({ kind: "CLOCK_MOVES", resetsAtReal: "2026-10-15T00:00:00.000Z" });
    expect(quotaOfRefusal({ quota: { kind: "SOMETHING_ELSE", resetsAtReal: "x" } })).toBeUndefined();
    expect(quotaOfRefusal(undefined)).toBeUndefined();
  });

  it("[FL-111] tells a daily limit from one that resets within the day, with the local reset time", () => {
    const daily = windowEnd("DAY", new Date("2026-10-14T13:20:00Z")).toISOString();
    const hourly = windowEnd("HOUR", new Date("2026-10-14T13:20:00Z")).toISOString();
    expect(isDailyReset(daily)).toBe(true);
    expect(isDailyReset(hourly)).toBe(false);
    expect(quotaMessage(es, { kind: "CLOCK_MOVES", resetsAtReal: daily })).toBe(es.quota.day(es.quota.kinds.CLOCK_MOVES, localTime(daily)));
    expect(quotaMessage(en, { kind: "AGENT_TURNS", resetsAtReal: hourly })).toBe(en.quota.hour(en.quota.kinds.AGENT_TURNS, localTime(hourly)));
    expect(quotaMessage(es, { kind: "GLOBAL", resetsAtReal: daily })).toBe(es.quota.global(localTime(daily)));
  });

  it("[FL-111] writes the time as HH:MM", () => {
    expect(localTime("2026-10-14T13:05:00Z")).toMatch(/^\d{2}:\d{2}$/);
    expect(localTime("not a date")).toBe("--:--");
  });

  it("[FL-111] keeps one usage line per kind, the window closest to its cap", () => {
    const [hour, day] = GUEST_QUOTAS.AGENT_TURNS;
    const lines = usageLines(es, [
      { kind: "AGENT_TURNS", window: hour?.window ?? "HOUR", used: 3, limit: hour?.limit ?? 1, resetsAtReal: "2026-10-14T14:00:00Z" },
      { kind: "AGENT_TURNS", window: day?.window ?? "DAY", used: day?.limit ?? 1, limit: day?.limit ?? 1, resetsAtReal: "2026-10-15T00:00:00Z" },
      { kind: "LIVE_CLOCK", window: "DAY", used: 0, limit: 6, resetsAtReal: "2026-10-15T00:00:00Z" },
    ]);
    expect(lines).toEqual([
      { kind: "AGENT_TURNS", label: es.quota.kinds.AGENT_TURNS, used: day?.limit, limit: day?.limit, exhausted: true },
      { kind: "LIVE_CLOCK", label: es.quota.kinds.LIVE_CLOCK, used: 0, limit: 6, exhausted: false },
    ]);
  });
});
