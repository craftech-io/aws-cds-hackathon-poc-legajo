// Usage quotas of guest worlds in real time (ADR-0015 §4), with the numbers of guest-limits.ts: each
// kind stops at the first full window with `QUOTA_EXCEEDED {kind, resetsAtReal}`, counts nothing past
// it, applies to reserved and public worlds alike, and the public worlds share a daily budget.
import { describe, expect, it } from "vitest";
import { QuotaExceededError } from "@legajo/shared/errors";
import { GUEST_QUOTAS, PUBLIC_GLOBAL_BUDGET } from "@legajo/shared/guest-limits";
import { memoryStores } from "../connector/testing";
import { createLogger } from "../lib/log";
import { consumeQuota, consumeWorldPreparation, readUsage } from "./guest-quotas";

const NOW = new Date("2026-10-14T13:20:00.000Z");
const PUBLIC = "GUEST#firm-guest-41";
const RESERVED = "GUEST#firm-guest-07";

function setup(now: () => Date = () => NOW) {
  const { client } = memoryStores();
  const lines: string[] = [];
  return { client, lines, deps: { client, now, log: createLogger({ level: "debug", sink: (line) => lines.push(line) }) } };
}

const limitOf = (kind: keyof typeof GUEST_QUOTAS, window: string) => GUEST_QUOTAS[kind].find((limit) => limit.window === window)?.limit ?? 0;

async function rejection(run: () => Promise<void>): Promise<QuotaExceededError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof QuotaExceededError) return error;
    throw error;
  }
  throw new Error("expected QUOTA_EXCEEDED");
}

describe("[FL-111] quotas of a guest world", () => {
  it("stops at the hourly limit with the hour's end, counts nothing past it and opens again", async () => {
    let now = NOW;
    const { deps, client, lines } = setup(() => now);
    for (let index = 0; index < limitOf("OUTBOUND_EMAILS", "HOUR"); index += 1) await consumeQuota(deps, PUBLIC, "OUTBOUND_EMAILS");
    const refused = await rejection(() => consumeQuota(deps, PUBLIC, "OUTBOUND_EMAILS"));
    expect({ kind: refused.kind, resetsAtReal: refused.resetsAtReal }).toEqual({ kind: "OUTBOUND_EMAILS", resetsAtReal: "2026-10-14T14:00:00.000Z" });
    expect((await readUsage(client, { clockId: PUBLIC, sub: "sub-a" }, now)).quotas).toContainEqual(expect.objectContaining({ kind: "OUTBOUND_EMAILS", window: "HOUR", used: limitOf("OUTBOUND_EMAILS", "HOUR") }));
    expect(lines.some((line) => line.includes('"metric":"QuotaHits"'))).toBe(true);
    now = new Date("2026-10-14T14:00:00.000Z");
    await expect(consumeQuota(deps, PUBLIC, "OUTBOUND_EMAILS")).resolves.toBeUndefined();
  });

  it("world resets: one every ten minutes", async () => {
    const { deps } = setup();
    await consumeQuota(deps, RESERVED, "WORLD_RESETS");
    const refused = await rejection(() => consumeQuota(deps, RESERVED, "WORLD_RESETS"));
    expect(refused.resetsAtReal).toBe("2026-10-14T13:30:00.000Z");
  });

  it("applies to reserved worlds too, and to no other world", async () => {
    const { deps, client } = setup();
    for (let index = 0; index < limitOf("NEW_OPERATIONS", "DAY"); index += 1) await consumeQuota(deps, RESERVED, "NEW_OPERATIONS");
    expect((await rejection(() => consumeQuota(deps, RESERVED, "NEW_OPERATIONS"))).kind).toBe("NEW_OPERATIONS");
    for (const clockId of ["GLOBAL#firm-delta", "qa-812-1-sc15", "sim-batch1"]) {
      for (let index = 0; index < 400; index += 1) await consumeQuota(deps, clockId, "CLOCK_MOVES");
    }
    expect(client.dump("Runtime").filter((row) => !row.PK.startsWith(`QUOTA#${RESERVED}`))).toEqual([]);
  });

  it("the public worlds share a daily budget of turns; past it QUOTA_EXCEEDED GLOBAL until 00:00 UTC", async () => {
    const { deps, lines } = setup();
    const budget = PUBLIC_GLOBAL_BUDGET.AGENT_TURNS ?? 0;
    const perWorld = limitOf("AGENT_TURNS", "DAY");
    const hourly = limitOf("AGENT_TURNS", "HOUR");
    let used = 0;
    for (let world = 31; used < budget; world += 1) {
      for (let index = 0; index < Math.min(hourly, perWorld, budget - used); index += 1) await consumeQuota(deps, `GUEST#firm-guest-${world}`, "AGENT_TURNS");
      used += Math.min(hourly, perWorld, budget - used);
    }
    const refused = await rejection(() => consumeQuota(deps, "GUEST#firm-guest-90", "AGENT_TURNS"));
    expect({ kind: refused.kind, resetsAtReal: refused.resetsAtReal }).toEqual({ kind: "GLOBAL", resetsAtReal: "2026-10-15T00:00:00.000Z" });
    expect(lines.some((line) => line.includes('"metric":"GuestBudgetHits"'))).toBe(true);
    // A reserved world is outside the public budget.
    await expect(consumeQuota(deps, RESERVED, "AGENT_TURNS")).resolves.toBeUndefined();
  }, 30_000);

  it("account.ensureWorld is counted per account", async () => {
    const { deps } = setup();
    for (let index = 0; index < limitOf("WORLD_PREPARATIONS", "HOUR"); index += 1) await consumeWorldPreparation(deps, "sub-a");
    expect((await rejection(() => consumeWorldPreparation(deps, "sub-a"))).kind).toBe("WORLD_PREPARATIONS");
    await expect(consumeWorldPreparation(deps, "sub-b")).resolves.toBeUndefined();
  });
});
