// `LegajoMetrics`: one KPI row per dossier and world or batch (`FIRM#<firmId>` /
// `<source>#<clockId>#<operationId>`). Producers add to counters atomically; the row is created on
// first use with its identity, so a turn and a console heartbeat never overwrite each other.
import { ConnectorError } from "@legajo/shared";
import { DossierKpi, KPI_COUNTERS } from "../../domain/metrics";
import type { TableName } from "../../lib/resource";
import { firmPartition, kpiKey } from "../keys";
import type { MetricsPort } from "../ports-runtime";
import { checkPatch, creationDefaults, defined, nowIso, optionalEntity, parseEntities, parseEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "LegajoMetrics";
const ADDABLE: ReadonlySet<string> = new Set([...KPI_COUNTERS, "humanMinutes"]);

export function metricsRepo(ctx: RepoContext): MetricsPort {
  const { client } = ctx;

  return {
    async getKpi(ref) {
      return optionalEntity(DossierKpi, "DossierKpi", await client.get(TABLE, kpiKey(ref.firmId, ref.source, ref.clockId, ref.operationId)), TABLE);
    },

    async listKpis(firmId, options = {}) {
      const prefix = options.source === undefined ? undefined : options.clockId === undefined ? `${options.source}#` : `${options.source}#${options.clockId}#`;
      const rows = await client.query(TABLE, { hashValue: firmPartition(firmId), ...(prefix ? { range: { prefix } } : {}) });
      const kpis = parseEntities(DossierKpi, "DossierKpi", rows, TABLE);
      return options.clockId === undefined ? kpis : kpis.filter((kpi) => kpi.clockId === options.clockId);
    },

    async incrementKpi(ref, deltas, identity) {
      const add: Record<string, number> = {};
      for (const [name, delta] of Object.entries(deltas)) {
        if (delta === undefined) continue;
        if (!ADDABLE.has(name) || !Number.isFinite(delta) || delta < 0) throw new ConnectorError("VALIDATION", `invalid KPI delta ${name}`, TABLE);
        add[name] = delta;
      }
      const fields = defined({ firmId: ref.firmId, source: ref.source, clockId: ref.clockId, operationId: ref.operationId, agentMode: identity.agentMode, runId: identity.runId });
      const row = await client.update(TABLE, kpiKey(ref.firmId, ref.source, ref.clockId, ref.operationId), { add, setIfAbsent: creationDefaults(ctx, "DossierKpi", fields) }, nowIso(ctx), { upsert: true });
      return parseEntity(DossierKpi, "DossierKpi", row, TABLE);
    },

    async updateKpi(ref, patch) {
      const fields = checkPatch(DossierKpi, patch, TABLE, `KPI of ${ref.operationId}`);
      return updateRow(ctx, TABLE, DossierKpi, "DossierKpi", kpiKey(ref.firmId, ref.source, ref.clockId, ref.operationId), { set: fields });
    },
  };
}
