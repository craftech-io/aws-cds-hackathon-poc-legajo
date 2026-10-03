import { createMemoryStores, type MemoryStores } from "@legajo/bff/connector/index";
import { contactFixture, importerFixture, operationFixture, hashOf, supplierFixture } from "@legajo/bff/connector/testing";
import { createLogger } from "@legajo/bff/lib/log";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { localBatchRunner } from "./batch-runner";
import { BATCH_INPUTS_FILE, BATCH_SIZE, readBatchInputs, runScriptedBatch, type BatchRunner } from "./batch-local";

const NOW = new Date("2026-09-26T15:00:00.000Z");
const now = () => NOW;
const log = createLogger({ level: "error", sink: () => undefined });
/** Every entry of the seed (docs/seed-spec.md §13). */
const SAMPLE = BATCH_SIZE;

interface Entry {
  readonly clockId: string;
  readonly turns: number;
  /** A WhatsApp that went out with no ALLOW decision: `policy_audit` must count it. */
  readonly sendWithoutAllow?: boolean;
}

/** Stand-in of the world factory: one world per entry with operation 4471, and what its run produced. */
function fakeRunner(): BatchRunner & { worlds: MemoryStores[] } {
  const worlds: MemoryStores[] = [];
  return {
    worlds,
    async run(raw) {
      const entry = raw as Entry;
      const stores = createMemoryStores({ now });
      worlds.push(stores);
      const scope = { firmId: "firm-sim", clockId: entry.clockId };
      const { parties, operations, metrics, conversations } = stores.connector;
      await parties.createImporter(importerFixture(scope));
      await parties.createSupplier(supplierFixture(scope));
      await parties.createContact(contactFixture(scope));
      const operation = operationFixture(scope);
      await operations.createOperation({ ...operation, threadClaimHash: hashOf(operation.threadAddress) });
      await operations.transitionDossier({ operationId: "op-4471", to: "READY_FOR_REVIEW", atSim: "2026-10-16T09:00:00-03:00", by: "AGENT" });
      await metrics.incrementKpi({ ...scope, source: "BATCH", operationId: "op-4471" }, { turns: entry.turns, whatsappSent: 3, emailSent: 2, humanActions: 1, humanMinutes: 10 }, { agentMode: "SCRIPTED" });
      if (entry.sendWithoutAllow) {
        await conversations.appendMessage({
          messageId: "msg-01JBATCH",
          operationId: "op-4471",
          ...scope,
          direction: "OUT",
          channel: "WHATSAPP",
          kind: "REMINDER",
          counterpart: "IMPORTER",
          importerId: "imp-norpampa",
          to: "+5491155500101",
          from: "simulated",
          body: "Operación 4471: recordatorio.",
          status: "SENT",
          author: "AGENT",
          sentAtSim: "2026-10-15T10:00:00-03:00",
          sentAtReal: NOW.toISOString(),
        });
      }
      return { ...scope, data: stores.connector };
    },
  };
}

describe("metrics batch with the scripted agent", () => {
  it("reads one entry per non-empty line and names a line that is not JSON", () => {
    expect(readBatchInputs('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => readBatchInputs('{"a":1}\nnot json')).toThrow(/batch-inputs\.jsonl:2/);
  });

  it("writes one BATCH row per operation in firm-sim with agentMode SCRIPTED, the run id and the violations policy_audit finds", async () => {
    const target = createMemoryStores({ now });
    const summary = await runScriptedBatch({
      entries: [{ clockId: "sim-0001", turns: 6 }, { clockId: "sim-0002", turns: 8, sendWithoutAllow: true }],
      runner: fakeRunner(),
      target: target.connector.metrics,
      runId: "local-test-run",
      now,
      log,
    });

    const rows = await target.connector.metrics.listKpis("firm-sim", { source: "BATCH" });
    expect(rows.map((row) => [row.clockId, row.operationId, row.agentMode, row.runId, row.source, row.dossierStatus])).toEqual([
      ["sim-0001", "op-4471", "SCRIPTED", "local-test-run", "BATCH", "READY_FOR_REVIEW"],
      ["sim-0002", "op-4471", "SCRIPTED", "local-test-run", "BATCH", "READY_FOR_REVIEW"],
    ]);
    expect(rows.map((row) => row.turns)).toEqual([6, 8]);
    expect(rows[0]).toMatchObject({ whatsappSent: 3, emailSent: 2, humanActions: 1, humanMinutes: 10, violations: 0 });
    expect(rows[1]?.violations).toBeGreaterThanOrEqual(1);
    expect(summary).toMatchObject({ runId: "local-test-run", worlds: 2, rows: 2, skipped: 0, turns: 14 });
    expect(summary.violations).toBe(rows[1]?.violations);
  });

  it("resumes a run with the same id without adding twice, and refuses rows of another run", async () => {
    const target = createMemoryStores({ now });
    const options = { entries: [{ clockId: "sim-0001", turns: 6 }], target: target.connector.metrics, now, log };
    await runScriptedBatch({ ...options, runner: fakeRunner(), runId: "run-a" });
    const again = await runScriptedBatch({ ...options, runner: fakeRunner(), runId: "run-a" });
    expect(again).toMatchObject({ rows: 0, skipped: 1 });
    expect((await target.connector.metrics.listKpis("firm-sim"))[0]?.turns).toBe(6);
    await expect(runScriptedBatch({ ...options, runner: fakeRunner(), runId: "run-b" })).rejects.toThrow(/another run \(run-a/);
  });

  it("a resume completes a row of the same run that a cut left without its status, and counts nothing twice", async () => {
    const target = createMemoryStores({ now });
    const ref = { firmId: "firm-sim", source: "BATCH" as const, clockId: "sim-0001", operationId: "op-4471" };
    await target.connector.metrics.incrementKpi(ref, { turns: 6 }, { agentMode: "SCRIPTED", runId: "run-a" });

    const summary = await runScriptedBatch({ entries: [{ clockId: "sim-0001", turns: 6 }], runner: fakeRunner(), target: target.connector.metrics, runId: "run-a", now, log });

    expect(summary).toMatchObject({ rows: 0, skipped: 1 });
    expect(await target.connector.metrics.getKpi(ref)).toMatchObject({ turns: 6, dossierStatus: "READY_FOR_REVIEW" });
  });

  it("runs the 200 entries of the seed through the in-process world with the scripted agent: one SCRIPTED row per entry, real turns, and 0 violations", async () => {
    const entries = readBatchInputs(readFileSync(BATCH_INPUTS_FILE, "utf8"));
    expect(entries).toHaveLength(BATCH_SIZE);
    const target = createMemoryStores({ now });
    const local = await localBatchRunner();
    try {
      const summary = await runScriptedBatch({ entries: entries.slice(0, SAMPLE), runner: local.runner, target: target.connector.metrics, runId: "local-scripted", now, log });
      const rows = await target.connector.metrics.listKpis("firm-sim", { source: "BATCH" });
      expect(rows).toHaveLength(SAMPLE);
      expect(rows.every((row) => row.agentMode === "SCRIPTED" && row.runId === "local-scripted")).toBe(true);
      expect(rows.map((row) => row.clockId)).toEqual(entries.slice(0, SAMPLE).map((entry) => (entry as { clockId: string }).clockId));
      expect(summary).toMatchObject({ worlds: SAMPLE, rows: SAMPLE, violations: 0 });
      expect(summary.turns).toBeGreaterThan(SAMPLE);
      // No world lost its turns to the firm's caps: every one ran at least its first request.
      expect(rows.filter((row) => row.turns === 0)).toEqual([]);
    } finally {
      local.close();
    }
  }, 300_000);
});
