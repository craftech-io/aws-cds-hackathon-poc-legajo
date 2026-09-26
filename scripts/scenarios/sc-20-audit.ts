// SC-20 · audit, metrics and isolation, the last scenario (docs/test-plan.md §4.5). It resets
// `GLOBAL#firm-qa` at the start and at the end (in its cleanup too), so every run finds the world of the
// `qa-min` template; it aggregates the policy audit of every earlier scenario of the run; and it proves
// that "Reiniciar demo" leaves no Memory of the previous epoch behind. Its own `sc20` worlds (clones of
// the judge template) carry the console reads and the paused-clock checks.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { RecordKey } from "@legajo/bff/qa-driver/contract-inputs";
import type { Inspection } from "@legajo/bff/qa-driver/memory-inspect";
import { QA_GLOBAL_CLOCK_ID } from "@legajo/shared";
import { SENT_STATUSES, outbound } from "./lib/asserts";
import { type ConsoleAction, consoleQuery } from "./lib/console";
import { WAITS } from "./lib/eventually";
import { matchesKeywords } from "@legajo/bff/qa-driver/keywords";
import { SENTINELS, sentinelMessage } from "./lib/sentinels";
import { type ScenarioContext, defineScenario, ensure } from "./lib/steps";
import { advanceTo, awaitState, createWorld, opOf, worldOf } from "./lib/world";

const JUDGE_START = "2026-10-14T10:30:00-03:00";
/** Manifest of the seed: `qaMetrics.aggregates` are the KPIs the `qa-min` fixture must produce (docs/seed-spec.md §15, invariant 14). */
const MANIFEST = "scripts/seed/data/manifest.json";
const ManifestAggregates = z.object({ qaMetrics: z.object({ aggregates: z.record(z.string(), z.number()) }).loose().optional() }).loose();

async function manifestAggregates(): Promise<Record<string, number> | undefined> {
  try {
    return ManifestAggregates.parse(JSON.parse(await readFile(MANIFEST, "utf8"))).qaMetrics?.aggregates;
  } catch {
    return undefined;
  }
}
const JUDGE_MODELS = ["op-4471", "op-4474", "op-4477", "op-4478", "op-4487", "op-4488"];

interface WorldMetrics {
  readonly usage: { readonly turns: number };
  readonly summary: { readonly kpis: ReadonlyArray<{ readonly key: string; readonly n: number; readonly source: string; readonly label: string; readonly value: number | null }> };
  readonly operations: ReadonlyArray<{ readonly operationId: string; readonly importerId: string; readonly dossierStatus: string }>;
}

async function resetGlobalQa(ctx: ScenarioContext): Promise<void> {
  await ctx.qa("console", { procedure: "clock.reset", input: { clockId: QA_GLOBAL_CLOCK_ID } });
}

async function globalQaOperation(ctx: ScenarioContext): Promise<string> {
  const metrics = (await ctx.qa("metrics.get", { clockId: QA_GLOBAL_CLOCK_ID })) as WorldMetrics;
  const first = metrics.operations[0];
  ensure(first !== undefined, "GLOBAL#firm-qa has the operations of the qa-min template");
  return first.operationId;
}

/** A turn of the importer with a sentinel; answers the Memory inspection once the extraction is complete. */
async function sentinelTurn(ctx: ScenarioContext, operationId: string, sentinel: typeof SENTINELS.A | typeof SENTINELS.B, baseline: RecordKey[]): Promise<Inspection> {
  const since = (await ctx.snapshot(operationId)).clock.simNow;
  await ctx.qa("wa.inbound", { operationId, message: { type: "text", text: sentinelMessage(sentinel) } });
  await awaitState(ctx, operationId, "the answer to the sentinel turn", (snapshot) => outbound(snapshot, { channel: "WHATSAPP", status: [...SENT_STATUSES], sinceSim: since }).length > 0);
  await ctx.qa("op.settle", { operationId, timeoutSec: WAITS.settleSec });
  return (await ctx.qa("memory.inspect", { operationId, waitForExtraction: { sentinel: { keywords: [...sentinel.keywords] }, baseline, afterTs: new Date().toISOString() } })) as Inspection;
}

const keysOf = (inspection: Inspection): RecordKey[] => inspection.records.map((record) => ({ memoryRecordId: record.memoryRecordId, createdAt: record.createdAt, contentSha256: record.contentSha256 }));

export const sc20 = defineScenario({
  id: "SC-20",
  slug: "sc20",
  title: "Audit, metrics and isolation",
  suites: ["full"],
  last: true,
  cleanup: resetGlobalQa,
  steps: [
    {
      n: 0,
      title: "GLOBAL#firm-qa starts from the qa-min template (QA is exempt from the console's limit)",
      flows: [],
      async run(ctx) {
        await resetGlobalQa(ctx);
        await createWorld(ctx, { startAtSim: JUDGE_START, operations: JUDGE_MODELS.map((model, index) => ({ key: `j${index}`, model })) });
      },
    },
    {
      n: 1,
      title: "the recipient fence in test mode: no call to SES",
      flows: ["FL-059"],
      async run(ctx) {
        const clockId = worldOf(ctx).clockId;
        const probe = async (to: string) => (await ctx.qa("fence.probe", { clockId, to })) as { allowed: boolean; ruleIds: string[] };
        ctx.check((await probe(opOf(ctx, "j0").contacts[0]?.email ?? "")).allowed, "a simulated supplier mailbox is allowed");
        for (const to of [opOf(ctx, "j0").threadAddress, "ventas@example.org", "compras@proveedor.test", "operaciones@demo.craftech.io"]) ctx.check(!(await probe(to)).allowed, `the fence refuses ${to.replace(/^[^@]+/, "…")}`);
      },
    },
    {
      n: 2,
      title: "every scenario of the run ended with 0 policy violations",
      flows: ["FL-060"],
      async run(ctx) {
        const violations = ctx.previous.reduce((sum, row) => sum + row.violations, 0);
        const unaudited = ctx.previous.filter((row) => row.unaudited > 0).map((row) => row.scenario);
        ctx.check(violations === 0, `${violations} policy violation(s) in the run`);
        ctx.check(unaudited.length === 0, `worlds without a policy audit: ${unaudited.join(", ")}`);
      },
    },
    {
      n: 3,
      title: "the console refuses another firm's data to the QA principal as to anyone",
      flows: ["FL-082"],
      async run(ctx) {
        const calls: ConsoleAction[] = [
          { procedure: "operations.get", input: { operationId: "op-4471" } },
          { procedure: "operations.list", input: { clockId: "GLOBAL#firm-delta" } },
        ];
        for (const call of calls) {
          const answer = await ctx.attempt("console", call);
          ctx.check(!answer.ok && answer.error.code === "FORBIDDEN" && answer.error.reason === "CROSS_FIRM", `${call.procedure} of firm-delta is 403 CROSS_FIRM`);
        }
      },
    },
    {
      n: 4,
      title: "the KPIs of the freshly reset GLOBAL#firm-qa carry N, source and label",
      flows: ["FL-085"],
      async run(ctx) {
        const metrics = (await ctx.qa("metrics.get", { clockId: QA_GLOBAL_CLOCK_ID })) as WorldMetrics;
        ctx.check(metrics.summary.kpis.length > 0, "the world has KPIs");
        for (const kpi of metrics.summary.kpis) ctx.check(typeof kpi.n === "number" && kpi.source !== "" && kpi.label !== "", `${kpi.key} has its N, source and label`);
        const expected = await manifestAggregates();
        if (expected === undefined) ctx.warn(`${MANIFEST} carries no QA metrics aggregates to compare with`);
        for (const [key, value] of Object.entries(expected ?? {})) ctx.check(metrics.summary.kpis.find((kpi) => kpi.key === key)?.value === value, `${key} equals the manifest's ${value}`);
      },
    },
    {
      n: 5,
      title: "after “Reiniciar demo” no Memory of the old epoch remains and none leaks into the new one",
      flows: ["FL-087"],
      async run(ctx) {
        const before = await globalQaOperation(ctx);
        const baseline = keysOf((await ctx.qa("memory.inspect", { operationId: before })) as Inspection);
        const old = await sentinelTurn(ctx, before, SENTINELS.A, baseline);
        await resetGlobalQa(ctx);
        await ctx.eventually("no event and no record of the old actor", async () => {
          const left = (await ctx.qa("memory.inspect", { actorId: old.actorId, sessionIds: [...old.sessionIds], clockId: QA_GLOBAL_CLOCK_ID })) as Inspection;
          return left.events.length === 0 && left.records.length === 0;
        }, WAITS.memoryPurgeSec, 15);
        const after = await globalQaOperation(ctx);
        const fresh = (await ctx.qa("memory.inspect", { operationId: after })) as Inspection;
        ctx.check(fresh.actorId !== old.actorId && fresh.records.length === 0, "the new epoch has a new actor with no records");
        const next = await sentinelTurn(ctx, after, SENTINELS.B, []);
        const leaked = next.records.filter((record) => record.strategy === "preferences" && matchesKeywords(record.text, SENTINELS.A.keywords));
        ctx.check(leaked.length === 0, "no preference of the old epoch came back");
        const snapshot = await ctx.settled(after);
        const missing = snapshot.documents.filter((row) => row.status !== "VALID").map((row) => row.docType).sort();
        const reply = outbound(snapshot, { kind: "REPLY" }).at(-1);
        ctx.check(JSON.stringify([...(reply?.refs.docTypes ?? [])].sort()) === JSON.stringify(missing), "the answer of the new epoch lists the template's missing documents");
        ctx.check(snapshot.turnNotes.every((note) => !matchesKeywords(note.text, SENTINELS.A.keywords)), "no turn note of the new epoch mentions the old conversation");
      },
    },
    {
      n: 6,
      title: "operations.list with filters shows only the firm's operations of the world",
      flows: ["FL-080"],
      async run(ctx) {
        const clockId = worldOf(ctx).clockId;
        const listed = await consoleQuery(ctx, "operations", "list", { clockId, statuses: ["OPEN"] });
        const ofWorld = new Set(worldOf(ctx).operations.map((operation) => operation.operationId));
        ctx.check(listed.operations.length > 0 && listed.operations.every((row) => row.dossierStatus === "OPEN" && ofWorld.has(row.operationId)), "only OPEN operations of this world of the firm");
      },
    },
    {
      n: 7,
      title: "audit log, violations and decisions by rule",
      flows: ["FL-086"],
      async run(ctx) {
        const clockId = worldOf(ctx).clockId;
        const log = await consoleQuery(ctx, "audit", "list", { clockId });
        const violations = await consoleQuery(ctx, "audit", "violations", { clockId });
        const byRule = await consoleQuery(ctx, "audit", "decisionsByRule", { clockId });
        const ofWorld = new Set(worldOf(ctx).operations.map((operation) => operation.operationId));
        ctx.check(log.decisions.length > 0 && log.decisions.every((row) => row.operationId === undefined || ofWorld.has(row.operationId)), "the log shows the world's decisions");
        ctx.check(violations.count === 0, `${violations.count} violation(s) in the world`);
        ctx.check(typeof byRule.byRule === "object", "decisions by rule answer");
      },
    },
    {
      n: 8,
      title: "G1 is active: a known attack is intervened",
      flows: ["FL-047"],
      async run(ctx) {
        const probe = (await ctx.qa("guardrail.probe", {})) as { action: string };
        ctx.check(probe.action === "GUARDRAIL_INTERVENED", `ApplyGuardrail answered ${probe.action}`);
      },
    },
    {
      n: 9,
      title: "two worlds of the judge template: paused clocks never move alone; one advances and approves, the other does not change",
      flows: ["FL-065", "FL-087"],
      async run(ctx) {
        await createWorld(ctx, { suffix: "b", startAtSim: JUDGE_START, operations: JUDGE_MODELS.map((model, index) => ({ key: `j${index}`, model })) });
        const [first, second] = [opOf(ctx, "j5").operationId, opOf(ctx, "j5", "b").operationId];
        const before = [await ctx.snapshot(first), await ctx.snapshot(second)].map((snapshot) => snapshot.clock.simNow);
        await ctx.pause(10 * 60);
        const idle = [await ctx.snapshot(first), await ctx.snapshot(second)].map((snapshot) => snapshot.clock.simNow);
        ctx.check(JSON.stringify(idle) === JSON.stringify(before), "no paused world moved in 10 real minutes");
        await advanceTo(ctx, first, "2026-10-15T10:00:00-03:00");
        await ctx.qa("console", { procedure: "dossier.approve", input: { operationId: first } });
        await awaitState(ctx, first, "approved in the first world", (snapshot) => snapshot.operation.dossierStatus === "APPROVED");
        const untouched = await ctx.snapshot(second);
        ctx.check(untouched.clock.simNow === before[1] && untouched.operation.dossierStatus !== "APPROVED", "the second world did not change");
      },
    },
  ],
});
