// KPIs of the metrics view (docs/design-brief.md §8, FL-085). One tab per source, never mixed in a
// number: "Este mundo" (the user's world, measured), "Lote · agente real" (batch rows of the real
// Harness, measured) and "Lote · agente guionado" (batch rows of the scripted Harness). Every KPI says
// its N, the source it comes from and its label; a number built on a declared assumption says so,
// and a KPI that does not apply to a tab (correct responsible with a scripted agent) is "no aplica",
// never a zero.
import { z } from "zod";
import type { AgentMode, MetricSource } from "@legajo/shared";
import type { Decision } from "../domain/audit";
import { entryAt } from "../domain/common";
import type { FirmSettings } from "../domain/firms";
import type { DossierKpi } from "../domain/metrics";
import type { EtaEvent } from "../domain/operations";
import type { RateCard } from "../domain/reference";
import { type DossierCost, RateCardRow, dossierCost } from "../services/ratecard";

export const KpiTab = z.enum(["WORLD", "BATCH_REAL", "BATCH_SCRIPTED"]);
export type KpiTab = z.infer<typeof KpiTab>;

/** "medido", "agente guionado" or "supuesto" in the console. */
export const KpiLabel = z.enum(["MEASURED", "SCRIPTED_AGENT", "ASSUMPTION"]);
export type KpiLabel = z.infer<typeof KpiLabel>;

export const KpiKey = z.enum([
  "humanMinutesPerDossier",
  "manualBaselineMinutes",
  "consoleMinutesObserved",
  "interventionsPerDossier",
  "completeBeforeArrivalPct",
  "correctResponsiblePct",
  "policyViolations",
  "costPerDossierUsd",
]);
export type KpiKey = z.infer<typeof KpiKey>;

/** Why a KPI has no number: it does not apply to the tab, there is nothing to measure yet, or no verified rate. */
export type KpiGap = "NOT_APPLICABLE" | "NO_DATA" | "UNVERIFIED_RATES";

export interface Kpi {
  readonly key: KpiKey;
  readonly value: number | null;
  /** Dossiers (or items) the number is computed over. */
  readonly n: number;
  readonly source: MetricSource | "FIRM_SETTINGS" | "AUDIT_LOG";
  readonly label: KpiLabel;
  readonly gap?: KpiGap;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface TabSelector {
  readonly source: MetricSource;
  readonly agentMode?: AgentMode;
  /** Only rows of this world ("Este mundo"). */
  readonly clockId?: string;
}

/** Which rows feed each tab; a row of another source or mode never reaches it. */
export function tabSelector(tab: KpiTab, worldClockId?: string): TabSelector {
  if (tab === "WORLD") return worldClockId === undefined ? { source: "WORLD" } : { source: "WORLD", clockId: worldClockId };
  return { source: "BATCH", agentMode: tab === "BATCH_REAL" ? "REAL" : "SCRIPTED" };
}

export function rowsOfTab(rows: readonly DossierKpi[], selector: TabSelector): DossierKpi[] {
  return rows.filter(
    (row) =>
      row.source === selector.source &&
      (selector.agentMode === undefined || row.agentMode === selector.agentMode) &&
      (selector.clockId === undefined || row.clockId === selector.clockId),
  );
}

/** Label of what the tab measures: the scripted batch never reads as a measurement of the real agent. */
export function tabLabel(tab: KpiTab): KpiLabel {
  return tab === "BATCH_SCRIPTED" ? "SCRIPTED_AGENT" : "MEASURED";
}

/** Complete means the 3 documents VALID at least 72 hours before the ETA in force when it completed. */
export const COMPLETE_BEFORE_ARRIVAL_HOURS = 72;

export interface SummaryInput {
  readonly tab: KpiTab;
  /** Rows of the tab only (`rowsOfTab`). */
  readonly rows: readonly DossierKpi[];
  readonly settings: Pick<FirmSettings, "manualBaseline">;
  /** ETA history of each operation of the rows, to read the ETA in force at completion. */
  readonly etaHistories: ReadonlyMap<string, readonly Pick<EtaEvent, "eta" | "atSim">[]>;
  /** `VIOLATION` decisions of the world ("Este mundo"); the batch tabs use their rows' counter. */
  readonly violations: readonly Pick<Decision, "operationId" | "clockId">[];
  /** DENY and DEFER decisions of the world, shown by rule next to the violations. */
  readonly denials: readonly Pick<Decision, "decision" | "ruleIds">[];
  readonly rateCard: readonly RateCard[];
  /** WhatsApp ran `simulated`: messages are priced as live and labelled so. */
  readonly whatsappSimulated: boolean;
}

export interface KpiSummary {
  readonly tab: KpiTab;
  readonly label: KpiLabel;
  readonly n: number;
  readonly kpis: readonly Kpi[];
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function perDossier(key: KpiKey, rows: readonly DossierKpi[], pick: (row: DossierKpi) => number, source: MetricSource, label: KpiLabel): Kpi {
  const value = average(rows.map(pick));
  return { key, value, n: rows.length, source, label, ...(value === null ? { gap: "NO_DATA" as const } : {}) };
}

/** The declared manual baseline: Σ count × minutes of its breakdown, always an assumption. */
export function manualBaselineKpi(settings: Pick<FirmSettings, "manualBaseline">): Kpi {
  const items = settings.manualBaseline.items;
  const minutes = items.reduce((sum, item) => sum + item.count * item.minutes, 0);
  return {
    key: "manualBaselineMinutes",
    value: round(minutes),
    n: items.length,
    source: "FIRM_SETTINGS",
    label: "ASSUMPTION",
    detail: { breakdown: items.map((item) => ({ action: item.action, count: item.count, minutes: item.minutes })), basis: settings.manualBaseline.source },
  };
}

function etaInForce(history: readonly Pick<EtaEvent, "eta" | "atSim">[] | undefined, atSim: string): string | undefined {
  if (history === undefined || history.length === 0) return undefined;
  return (entryAt(history, atSim) ?? history[0])?.eta;
}

/** Dossiers complete at least 72 h before the ETA in force when they completed, over every dossier of the tab. */
export function completeBeforeArrivalKpi(rows: readonly DossierKpi[], etaHistories: SummaryInput["etaHistories"], source: MetricSource, label: KpiLabel): Kpi {
  if (rows.length === 0) return { key: "completeBeforeArrivalPct", value: null, n: 0, source, label, gap: "NO_DATA" };
  const onTime = rows.filter((row) => {
    if (row.completedAtSim === undefined) return false;
    const eta = etaInForce(etaHistories.get(row.operationId), row.completedAtSim);
    return eta !== undefined && Date.parse(row.completedAtSim) <= Date.parse(eta) - COMPLETE_BEFORE_ARRIVAL_HOURS * 3_600_000;
  }).length;
  return { key: "completeBeforeArrivalPct", value: round((onTime / rows.length) * 100), n: rows.length, source, label, detail: { onTime } };
}

/** Only the real agent's assignments are compared with `Reference/EVAL#`: a scripted agent is "no aplica". */
export function correctResponsibleKpi(tab: KpiTab, rows: readonly DossierKpi[], source: MetricSource, label: KpiLabel): Kpi {
  const measured = rows.filter((row) => row.agentMode === "REAL");
  if (tab === "BATCH_SCRIPTED" || measured.length === 0) {
    return { key: "correctResponsiblePct", value: null, n: 0, source, label, gap: tab === "BATCH_SCRIPTED" ? "NOT_APPLICABLE" : "NO_DATA" };
  }
  const total = measured.reduce((sum, row) => sum + row.assignmentsTotal, 0);
  const correct = measured.reduce((sum, row) => sum + row.assignmentsCorrect, 0);
  if (total === 0) return { key: "correctResponsiblePct", value: null, n: 0, source, label, gap: "NO_DATA" };
  return { key: "correctResponsiblePct", value: round((correct / total) * 100), n: total, source, label, detail: { correct, dossiers: measured.length } };
}

/** DENY and DEFER decisions counted by rule: the policy stopping the agent is the evidence next to the 0. */
export function decisionsByRule(denials: SummaryInput["denials"]): Record<string, { deny: number; defer: number }> {
  const byRule: Record<string, { deny: number; defer: number }> = {};
  for (const denial of denials) {
    if (denial.decision !== "DENY" && denial.decision !== "DEFER") continue;
    for (const ruleId of denial.ruleIds) {
      const counts = (byRule[ruleId] ??= { deny: 0, defer: 0 });
      if (denial.decision === "DENY") counts.deny += 1;
      else counts.defer += 1;
    }
  }
  return byRule;
}

function violationsKpi(input: SummaryInput, source: MetricSource, label: KpiLabel): Kpi {
  const byRule = decisionsByRule(input.denials);
  if (input.tab === "WORLD") {
    return { key: "policyViolations", value: input.violations.length, n: input.rows.length, source: "AUDIT_LOG", label, detail: { decisionsByRule: byRule } };
  }
  const value = input.rows.reduce((sum, row) => sum + row.violations, 0);
  return { key: "policyViolations", value, n: input.rows.length, source, label };
}

/** Rate card rows as the pricing module reads them; a row it cannot price is left out (and so reported missing). */
export function pricingRows(rateCard: readonly RateCard[]): RateCardRow[] {
  return rateCard.flatMap((rate) => {
    const row = RateCardRow.safeParse({ key: rate.rateId, price: rate.price, unit: rate.unit, source: rate.source ?? null, asOf: rate.asOf ?? null, provisional: rate.provisional });
    return row.success ? [row.data] : [];
  });
}

function costOf(row: DossierKpi, rates: readonly RateCardRow[], whatsappSimulated: boolean): DossierCost {
  return dossierCost(
    {
      tokens: { input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens, cacheWrite: row.cacheWriteTokens },
      emails: row.emailSent,
      // The row counts WhatsApp sends without their pricing category; every one is priced as a template (utility).
      whatsapp: { utility: row.whatsappSent, service: 0 },
    },
    rates,
    { whatsappSimulated },
  );
}

export function costKpi(input: SummaryInput, source: MetricSource, label: KpiLabel): Kpi {
  const rates = pricingRows(input.rateCard);
  const costs = input.rows.map((row) => costOf(row, rates, input.whatsappSimulated));
  const whatsappPricedAsLive = costs.some((cost) => cost.whatsappPricedAsLive);
  const missing = [...new Set(costs.flatMap((cost) => (cost.status === "UNVERIFIED" ? cost.missingRates : [])))].sort();
  if (missing.length > 0) return { key: "costPerDossierUsd", value: null, n: input.rows.length, source, label, gap: "UNVERIFIED_RATES", detail: { missingRates: missing, whatsappPricedAsLive } };
  const usd = costs.map((cost) => (cost.status === "VERIFIED" ? cost.usd : 0));
  const value = usd.length === 0 ? null : Math.round((usd.reduce((sum, item) => sum + item, 0) / usd.length) * 10_000) / 10_000;
  return { key: "costPerDossierUsd", value, n: input.rows.length, source, label, ...(value === null ? { gap: "NO_DATA" as const } : {}), detail: { whatsappPricedAsLive } };
}

/** Every KPI of one tab. */
export function summarize(input: SummaryInput): KpiSummary {
  const label = tabLabel(input.tab);
  const source: MetricSource = input.tab === "WORLD" ? "WORLD" : "BATCH";
  const rows = input.rows;
  const kpis: Kpi[] = [
    // Human minutes multiply measured actions by the firm's declared minutes per action: an assumption.
    perDossier("humanMinutesPerDossier", rows, (row) => row.humanMinutes, source, "ASSUMPTION"),
    manualBaselineKpi(input.settings),
    perDossier("interventionsPerDossier", rows, (row) => row.interventions, source, label),
    completeBeforeArrivalKpi(rows, input.etaHistories, source, label),
    correctResponsibleKpi(input.tab, rows, source, label),
    violationsKpi(input, source, label),
    costKpi(input, source, label),
  ];
  // Console time is observed only in a world someone looks at; a batch has no console.
  if (input.tab === "WORLD") kpis.splice(2, 0, perDossier("consoleMinutesObserved", rows, (row) => row.consoleSeconds / 60, source, label));
  return { tab: input.tab, label, n: rows.length, kpis };
}

const CSV_COLUMNS = [
  "operationId",
  "clockId",
  "source",
  "agentMode",
  "dossierStatus",
  "turns",
  "whatsappSent",
  "emailSent",
  "humanActions",
  "humanMinutes",
  "interventions",
  "escalations",
  "violations",
  "assignmentsTotal",
  "assignmentsCorrect",
  "consoleSeconds",
  "openedAtSim",
  "completedAtSim",
] as const satisfies readonly (keyof DossierKpi)[];

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** `metrics.export`: the rows behind a tab, one per dossier, as CSV (no names, no contacts). */
export function kpiRowsCsv(rows: readonly DossierKpi[]): string {
  const lines = [CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column])).join(","))];
  return `${lines.join("\n")}\n`;
}
