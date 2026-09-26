// Pure rules of the metrics view (docs/design-brief.md §8, FL-085): each KPI of `metrics.summary`
// turned into what a tile shows (value in its unit, or why there is none), the N / source / label
// line every number carries, the notes a number needs (an assumption, a rate not verified yet,
// WhatsApp valued as live) and the manual baseline's breakdown. The free-form `detail` of a KPI is
// parsed with zod before anything reads it.
import { z } from "zod";
import { formatNumber } from "../../lib/format";
import type { RouterOutputs } from "../../lib/trpc-router";
import { metricsCopy } from "./copy";

export type MetricsSummary = RouterOutputs["metrics"]["summary"];
export type KpiView = MetricsSummary["kpis"][number];
export type KpiTabValue = MetricsSummary["tab"];

export const TABS: readonly KpiTabValue[] = ["WORLD", "BATCH_REAL", "BATCH_SCRIPTED"];

const BaselineDetail = z.looseObject({
  breakdown: z.array(z.looseObject({ action: z.string().min(1), count: z.number().nonnegative(), minutes: z.number().nonnegative() })),
  basis: z.string().optional(),
});
const CostDetail = z.looseObject({ missingRates: z.array(z.string()).optional(), whatsappPricedAsLive: z.boolean().optional() });
const ViolationsDetail = z.looseObject({ decisionsByRule: z.record(z.string(), z.looseObject({ deny: z.number().int().nonnegative(), defer: z.number().int().nonnegative() })) });

export type Tone = "neutral" | "success" | "danger" | "brand";

export interface KpiCard {
  readonly key: KpiView["key"];
  readonly title: string;
  readonly valueText: string;
  readonly tone: Tone;
  /** "N = 3 · fuente: este mundo · medido". */
  readonly hint: string;
  readonly notes: readonly string[];
}

function valueText(kpi: KpiView): string {
  if (kpi.value === null) return metricsCopy.gaps[kpi.gap ?? "NO_DATA"];
  const units = metricsCopy.units;
  switch (kpi.key) {
    case "humanMinutesPerDossier":
    case "manualBaselineMinutes":
    case "consoleMinutesObserved":
      return units.minutes(formatNumber(kpi.value, 1));
    case "completeBeforeArrivalPct":
    case "correctResponsiblePct":
      return units.percent(formatNumber(kpi.value, 1));
    case "costPerDossierUsd":
      return units.usd(formatNumber(kpi.value, 4));
    case "latencyP50Ms":
    case "latencyP95Ms":
      return units.seconds(formatNumber(kpi.value / 1000, 1));
    case "interventionsPerDossier":
      return formatNumber(kpi.value, 1);
    case "policyViolations":
      return formatNumber(kpi.value);
  }
}

function toneOf(kpi: KpiView): Tone {
  if (kpi.key === "policyViolations" && kpi.value !== null) return kpi.value === 0 ? "success" : "danger";
  return kpi.value === null ? "neutral" : "brand";
}

function notesOf(kpi: KpiView): string[] {
  const notes = metricsCopy.notes;
  switch (kpi.key) {
    case "humanMinutesPerDossier":
      return [notes.humanMinutes];
    case "manualBaselineMinutes":
      return [notes.baseline];
    case "correctResponsiblePct":
      return kpi.gap === "NOT_APPLICABLE" ? [notes.notApplicable] : [];
    case "policyViolations":
      return [notes.violations];
    case "costPerDossierUsd": {
      const detail = CostDetail.safeParse(kpi.detail ?? {});
      if (!detail.success) return [];
      const missing = detail.data.missingRates?.length ?? 0;
      return [...(detail.data.whatsappPricedAsLive ? [notes.whatsappAsLive] : []), ...(missing > 0 ? [notes.missingRates(missing)] : [])];
    }
    default:
      return [];
  }
}

export function kpiCard(kpi: KpiView): KpiCard {
  const hint = metricsCopy.hint(kpi.n, metricsCopy.sources[kpi.source], metricsCopy.labels[kpi.label]);
  return { key: kpi.key, title: metricsCopy.kpis[kpi.key], valueText: valueText(kpi), tone: toneOf(kpi), hint, notes: notesOf(kpi) };
}

export function kpiCards(summary: Pick<MetricsSummary, "kpis">): KpiCard[] {
  return summary.kpis.map(kpiCard);
}

export interface BaselineRow {
  readonly action: string;
  readonly count: number;
  readonly minutes: number;
}

export interface Baseline {
  readonly rows: readonly BaselineRow[];
  readonly totalMinutes: number;
  readonly basis: string | undefined;
}

/** The declared manual baseline of the tab (always an assumption); undefined when the BFF sent none. */
export function baselineOf(summary: Pick<MetricsSummary, "kpis">): Baseline | undefined {
  const kpi = summary.kpis.find((candidate) => candidate.key === "manualBaselineMinutes");
  const detail = BaselineDetail.safeParse(kpi?.detail ?? {});
  if (kpi === undefined || !detail.success) return undefined;
  const rows = detail.data.breakdown.map((item) => ({ action: item.action, count: item.count, minutes: item.minutes }));
  return { rows, totalMinutes: rows.reduce((sum, row) => sum + row.count * row.minutes, 0), basis: detail.data.basis };
}

/** DENY and DEFER by rule behind the violations KPI ("Este mundo"); empty for the batch tabs. */
export function decisionsByRuleOf(summary: Pick<MetricsSummary, "kpis">): Record<string, { deny: number; defer: number }> {
  const kpi = summary.kpis.find((candidate) => candidate.key === "policyViolations");
  const detail = ViolationsDetail.safeParse(kpi?.detail ?? {});
  return detail.success ? detail.data.decisionsByRule : {};
}

/** The summary line of a tab: its N and what its numbers are. */
export function summaryLine(summary: Pick<MetricsSummary, "n" | "label">): string {
  return metricsCopy.summary(summary.n, metricsCopy.labels[summary.label]);
}
