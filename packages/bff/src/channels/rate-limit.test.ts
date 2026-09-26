import { describe, expect, it } from "vitest";
import { hashOf, memoryStores } from "../connector/testing";
import { rateKey } from "../connector/keys";
import { DEFAULT_RATE_LIMIT_PER_HOUR, admitInbound, completeInbound, rateLimitOf, simHourOf } from "./rate-limit";

const CLOCK = "qa-812-1-sc18-rate";
const PHONE_HASH = hashOf("+5491155509001");
const AT_REAL = "2026-09-26T15:00:00.000Z";

function admit(runtime: Parameters<typeof admitInbound>[0], wamid: string, simNow: string, options: { clockId?: string; limit?: number } = {}) {
  return admitInbound(runtime, {
    delivery: { source: "WHATSAPP", id: wamid },
    clockId: options.clockId ?? CLOCK,
    addressHash: PHONE_HASH,
    simNow: new Date(simNow),
    limitPerHour: options.limit ?? 3,
  });
}

describe("[FL-094] rate limit per sender and simulated hour", () => {
  it("[FL-094] admits up to the world's limit in one simulated hour and refuses the next one", async () => {
    const { connector } = memoryStores();
    const outcomes = [];
    for (const [index, minute] of ["05", "20", "40", "59"].entries()) outcomes.push(await admit(connector.runtime, `wamid.SIM.${index}`, `2026-10-15T10:${minute}:00-03:00`));
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["ADMITTED", "ADMITTED", "ADMITTED", "RATE_LIMITED"]);
    expect(outcomes[3]).toEqual({ outcome: "RATE_LIMITED", count: 4, limit: 3, simHour: "2026-10-15T13" });
  });

  it("[FL-094] counts in RATE#<clockId>#<phoneHash>#<simHour>, the simulated hour truncated in UTC", async () => {
    const { connector, client } = memoryStores();
    await admit(connector.runtime, "wamid.SIM.a", "2026-10-15T10:59:59.999-03:00");
    const row = await client.get("Runtime", rateKey(CLOCK, PHONE_HASH, "2026-10-15T13"));
    expect(row).toMatchObject({ entity: "RateCounter", clockId: CLOCK, addressHash: PHONE_HASH, simHour: "2026-10-15T13", count: 1 });
    expect(simHourOf(new Date("2026-10-15T13:00:00.000Z"))).toBe("2026-10-15T13");
    expect(simHourOf(new Date("2026-10-15T10:59:59.999-03:00"))).toBe("2026-10-15T13");
  });

  it("[FL-094] drops a duplicate delivery (same wamid) before counting it", async () => {
    const { connector } = memoryStores();
    expect((await admit(connector.runtime, "wamid.SIM.dup", "2026-10-15T10:05:00-03:00")).outcome).toBe("ADMITTED");
    await completeInbound(connector.runtime, { source: "WHATSAPP", id: "wamid.SIM.dup" }, AT_REAL, { outcome: "TURN" });
    expect(await admit(connector.runtime, "wamid.SIM.dup", "2026-10-15T10:06:00-03:00")).toEqual({ outcome: "DUPLICATE" });
    const next = await admit(connector.runtime, "wamid.SIM.next", "2026-10-15T10:07:00-03:00");
    expect(next).toMatchObject({ outcome: "ADMITTED", count: 2 });
  });

  it("[FL-034] admits again a delivery whose processing never completed: only a completed one is a duplicate", async () => {
    const { connector } = memoryStores();
    expect((await admit(connector.runtime, "wamid.SIM.failed", "2026-10-15T10:05:00-03:00")).outcome).toBe("ADMITTED");
    expect(await connector.runtime.getIdempotency("WHATSAPP", "wamid.SIM.failed")).toBeUndefined();
    expect(await admit(connector.runtime, "wamid.SIM.failed", "2026-10-15T10:06:00-03:00")).toMatchObject({ outcome: "ADMITTED", count: 2 });
    await completeInbound(connector.runtime, { source: "WHATSAPP", id: "wamid.SIM.failed" }, AT_REAL, { outcome: "TURN" });
    expect(await admit(connector.runtime, "wamid.SIM.failed", "2026-10-15T10:07:00-03:00")).toEqual({ outcome: "DUPLICATE" });
  });

  it("[FL-094] starts a new counter in a new simulated hour", async () => {
    const { connector } = memoryStores();
    for (const index of [1, 2, 3, 4]) await admit(connector.runtime, `wamid.SIM.h${index}`, "2026-10-15T10:10:00-03:00");
    const nextHour = await admit(connector.runtime, "wamid.SIM.h5", "2026-10-15T11:10:00-03:00");
    expect(nextHour).toEqual({ outcome: "ADMITTED", count: 1, limit: 3, simHour: "2026-10-15T14" });
  });

  it("[FL-094] keeps one counter per world: the same phone in another world starts from zero", async () => {
    const { connector } = memoryStores();
    for (const index of [1, 2, 3, 4]) await admit(connector.runtime, `wamid.SIM.w${index}`, "2026-10-15T10:10:00-03:00");
    const other = await admit(connector.runtime, "wamid.SIM.w5", "2026-10-15T10:10:00-03:00", { clockId: "qa-812-1-sc18" });
    expect(other).toMatchObject({ outcome: "ADMITTED", count: 1 });
  });

  it("[FL-094] takes the limit from the world's settings, 20 when the clock has none", () => {
    expect(rateLimitOf({ settings: { rateLimitPerHour: 3 } })).toBe(3);
    expect(rateLimitOf(undefined)).toBe(DEFAULT_RATE_LIMIT_PER_HOUR);
    expect(DEFAULT_RATE_LIMIT_PER_HOUR).toBe(20);
  });

  it("refuses a limit that is not a positive integer", async () => {
    const { connector } = memoryStores();
    await expect(admit(connector.runtime, "wamid.SIM.z", "2026-10-15T10:10:00-03:00", { limit: 0 })).rejects.toThrow(RangeError);
  });
});
