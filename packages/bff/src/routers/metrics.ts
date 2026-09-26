// `metrics` router (docs/tool-catalog.md, docs/design-brief.md §8, FL-085): the KPIs of one tab, each
// with its N, source and label (metrics/kpis.ts), and the rows behind a tab as CSV. "Este mundo" reads
// the principal's world; the two batch tabs read the rows the metrics batch wrote in `firm-sim`, the
// same evidence for every firm (synthetic operations, no party of the firm).
import type { Connector } from "../connector/index";
import type { DossierKpi } from "../domain/metrics";
import { KpiTab, kpiRowsCsv, rowsOfTab, summarize, tabSelector } from "../metrics/kpis";
import { WorldFields, worldOf } from "./clock";
import { firmProcedure, router } from "./trpc";

/** Firm of the metrics batch worlds (`sim-*`, docs/seed-spec.md §3). */
export const BATCH_FIRM_ID = "firm-sim";

const TabInput = WorldFields.extend({ tab: KpiTab.default("WORLD") }).strict().prefault({});

interface TabRows {
  readonly firmId: string;
  readonly clockId?: string;
  readonly rows: DossierKpi[];
}

async function tabRows(data: Connector, firmId: string, tab: KpiTab, worldClockId: string | undefined): Promise<TabRows> {
  if (worldClockId !== undefined) {
    const rows = await data.metrics.listKpis(firmId, { source: "WORLD", clockId: worldClockId });
    return { firmId, clockId: worldClockId, rows: rowsOfTab(rows, tabSelector(tab, worldClockId)) };
  }
  const rows = await data.metrics.listKpis(BATCH_FIRM_ID, { source: "BATCH" });
  return { firmId: BATCH_FIRM_ID, rows: rowsOfTab(rows, tabSelector(tab)) };
}

async function etaHistoriesOf(data: Connector, scope: TabRows) {
  const operations = await data.operations.listOperations(scope.firmId, scope.clockId === undefined ? {} : { clockId: scope.clockId });
  return new Map(operations.map((operation) => [operation.operationId, operation.etaHistory] as const));
}

async function worldDecisions(data: Connector, firmId: string, clockId: string) {
  const [violations, denials, deferrals] = await Promise.all(
    (["VIOLATION", "DENY", "DEFER"] as const).map((decision) => data.audit.listByDecision(firmId, decision)),
  );
  const ofWorld = <T extends { readonly clockId?: string }>(rows: readonly T[] | undefined) => (rows ?? []).filter((row) => row.clockId === clockId);
  return { violations: ofWorld(violations), denials: [...ofWorld(denials), ...ofWorld(deferrals)] };
}

export const metricsRouter = router({
  summary: firmProcedure.input(TabInput).query(async ({ ctx, input }) => {
    const data = ctx.deps.connector;
    // Only "Este mundo" needs a world; the batch tabs are the same for everyone.
    const clockId = input.tab === "WORLD" ? await worldOf(ctx, input.clockId) : undefined;
    const scope = await tabRows(data, ctx.principal.firmId, input.tab, clockId);
    const [settings, etaHistories, decisions, rateCard] = await Promise.all([
      data.firms.getSettings(ctx.principal.firmId),
      etaHistoriesOf(data, scope),
      clockId === undefined ? Promise.resolve({ violations: [], denials: [] }) : worldDecisions(data, ctx.principal.firmId, clockId),
      data.reference.listRateCard(),
    ]);
    const summary = summarize({
      tab: input.tab,
      rows: scope.rows,
      settings,
      etaHistories,
      violations: decisions.violations,
      denials: decisions.denials,
      rateCard,
      whatsappSimulated: ctx.deps.whatsappMode() === "simulated",
    });
    return { clockId: clockId ?? null, ...summary };
  }),

  export: firmProcedure.input(TabInput).query(async ({ ctx, input }) => {
    const clockId = input.tab === "WORLD" ? await worldOf(ctx, input.clockId) : undefined;
    const scope = await tabRows(ctx.deps.connector, ctx.principal.firmId, input.tab, clockId);
    return { tab: input.tab, filename: `legajo-metrics-${input.tab.toLowerCase()}.csv`, csv: kpiRowsCsv(scope.rows) };
  }),
});
