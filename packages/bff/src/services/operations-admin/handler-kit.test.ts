import { describe, expect, it } from "vitest";
import { QuotaExceededError } from "@legajo/shared/errors";
import { DIRECT_HANDLERS, unwrapDirect } from "./handler-kit";
import { directHandlers } from "./handlers";
import { recordActivityHandler } from "./record-activity";
import { FIRM, OPERATION, consoleCaller, serviceWorld } from "./testing";

describe("direct handlers: who may call", () => {
  it("implements every handler of the catalog this package owns", async () => {
    const world = await serviceWorld();
    expect(Object.keys(directHandlers(world.deps)).sort()).toEqual([...DIRECT_HANDLERS].sort());
  });

  it("refuses a session token next to a caller (LAM-CALLER), a caller that does not parse, and a kind the catalog does not list", async () => {
    const world = await serviceWorld();
    const take = directHandlers(world.deps).take_conversation;
    expect(await take({ sessionToken: "s.t.1.sig", caller: consoleCaller(), operationId: OPERATION })).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "CALLER_WITH_TOKEN" } });
    expect(await take({ caller: { kind: "HARNESS" }, operationId: OPERATION })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "CALLER_INVALID" } });
    expect(await take({ caller: { kind: "WORKER", firmId: FIRM }, operationId: OPERATION })).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "CALLER_NOT_ALLOWED" } });
    expect(await take("op-4471")).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("lets QA act only inside a QA firm", async () => {
    const world = await serviceWorld();
    const take = directHandlers(world.deps).take_conversation;
    expect(await take({ caller: { kind: "QA", firmId: FIRM, brokerId: "brk-delta-diego", role: "BROKER" }, operationId: OPERATION })).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "QA_FIRM_ONLY" } });
  });

  it("parses the input strict: an undeclared key is INVALID, reported by its path only", async () => {
    const world = await serviceWorld();
    const answer = await directHandlers(world.deps).take_conversation({ caller: consoleCaller(), operationId: OPERATION, decision: "APPROVED" });
    expect(answer).toMatchObject({ ok: false, error: { code: "INVALID", reason: "VALIDATION", message: "invalid input: decision" } });
  });

  it("gives the routers a spent quota back as QuotaExceededError with its renewal", () => {
    const failure = { ok: false as const, error: { code: "POLICY_DENIED" as const, message: "limit", reason: "QUOTA_EXCEEDED" }, quota: { kind: "NEW_OPERATIONS" as const, resetsAtReal: "2026-09-27T00:00:00.000Z" } };
    expect(() => unwrapDirect(failure)).toThrow(QuotaExceededError);
  });
});

describe("record_activity", () => {
  it("adds the console's observed seconds to the dossier's KPI row, at most a minute per beat, and writes no audit row", async () => {
    const world = await serviceWorld();
    const beat = recordActivityHandler(world.deps);
    unwrapDirect(await beat({ caller: consoleCaller(), operationId: OPERATION }));
    unwrapDirect(await beat({ caller: consoleCaller(), operationId: OPERATION, seconds: 12 }));
    const kpi = await world.stores.connector.metrics.getKpi({ firmId: FIRM, source: "WORLD", clockId: "GLOBAL#firm-delta", operationId: OPERATION });
    expect(kpi).toMatchObject({ consoleSeconds: 42 });
    expect(await beat({ caller: consoleCaller(), operationId: OPERATION, seconds: 600 })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await beat({ caller: consoleCaller("firm-norte"), operationId: OPERATION })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await world.stores.connector.audit.listByDecision(FIRM, "ACTION")).toEqual([]);
  });
});
