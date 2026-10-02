// CP-WORLD-QUOTA (ADR-0015 §4): an email of a guest world goes out only inside its quota; the engine
// decides on the verdict the pipeline counted, audits a denial like any other, fails closed without
// one, and leaves every other world and every past send alone.
import { describe, expect, it } from "vitest";
import { GUEST_QUOTAS } from "@legajo/shared/guest-limits";
import { memoryStores } from "../connector/testing";
import { createLogger } from "../lib/log";
import { evaluate, evaluateIn } from "./engine";
import { toSupplier } from "./testing";
import { WORLD_QUOTA_SKIP_PAST, worldQuotaVerdict } from "./world-quota";

const GUEST = "GUEST#firm-guest-41";
const ruleOf = (decision: ReturnType<typeof evaluate>) => decision.evaluated.find((entry) => entry.ruleId === "CP-WORLD-QUOTA");

describe("[FL-111] CP-WORLD-QUOTA", () => {
  it("passes an email of a guest world inside its quota and denies it once the quota is spent", async () => {
    const { client } = memoryStores();
    const deps = { client, now: () => new Date("2026-10-14T13:20:00.000Z"), log: createLogger({ level: "error" }) };
    const hourly = GUEST_QUOTAS.OUTBOUND_EMAILS[0]?.limit ?? 0;
    for (let index = 0; index < hourly; index += 1) {
      const verdict = await worldQuotaVerdict(deps, GUEST);
      expect(evaluate(toSupplier({ worldQuota: verdict })).outcome).toBe("ALLOW");
    }
    const spent = await worldQuotaVerdict(deps, GUEST);
    expect(spent).toMatchObject({ clockId: GUEST, allowed: false });
    const decision = evaluate(toSupplier({ worldQuota: spent }));
    expect(decision).toMatchObject({ outcome: "DENY", ruleIds: ["CP-WORLD-QUOTA"], errorCode: "POLICY_DENIED" });
    expect(decision.reason).toContain("2026-10-14T14:00:00.000Z");
  });

  it("fails closed for an email of a guest world without a counted verdict", () => {
    expect(evaluate(toSupplier({ worldQuota: { clockId: GUEST } }))).toMatchObject({ outcome: "DENY", ruleIds: ["CP-WORLD-QUOTA"] });
  });

  it("other worlds have no quota: no verdict, the rule skips", async () => {
    const { client } = memoryStores();
    expect(await worldQuotaVerdict({ client, now: () => new Date(), log: createLogger({ level: "error" }) }, "GLOBAL#firm-delta")).toBeUndefined();
    expect(client.dump("Runtime")).toEqual([]);
    expect(ruleOf(evaluate(toSupplier()))).toMatchObject({ result: "SKIP" });
    expect(ruleOf(evaluate(toSupplier({ worldQuota: { clockId: "GLOBAL#firm-delta" } })))).toMatchObject({ result: "SKIP" });
  });

  it("is last: every other rule decides first, and a past send is never re-counted", () => {
    const decision = evaluate(toSupplier({ worldQuota: { clockId: GUEST, allowed: false }, contact: undefined }));
    expect(decision.ruleIds).toEqual(["CP-SUPPLIER-AUTH"]);
    const past = evaluateIn("AS_OF", toSupplier({ worldQuota: { clockId: GUEST, allowed: false } }));
    expect(ruleOf(past)).toEqual({ ruleId: "CP-WORLD-QUOTA", result: "SKIP", detail: WORLD_QUOTA_SKIP_PAST });
  });
});
