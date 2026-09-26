import { describe, expect, it } from "vitest";
import { DossierKpi } from "../domain/metrics";
import { RateCard } from "../domain/reference";
import { type Kpi, type KpiKey, type SummaryInput, kpiRowsCsv, rowsOfTab, summarize, tabSelector } from "./kpis";

const STAMP = { createdAt: "2026-09-26T15:00:00.000Z", updatedAt: "2026-09-26T15:00:00.000Z", version: 1 };

function row(overrides: Partial<DossierKpi> & Pick<DossierKpi, "operationId">): DossierKpi {
  return DossierKpi.parse({ ...STAMP, firmId: "firm-delta", source: "WORLD", clockId: "GLOBAL#firm-delta", agentMode: "REAL", ...overrides });
}

const SETTINGS: SummaryInput["settings"] = {
  manualBaseline: {
    items: [
      { action: "Contactos por legajo", count: 8, minutes: 8, label: "supuesto" },
      { action: "Revisión de documentos", count: 3, minutes: 7, label: "supuesto" },
      { action: "Armado", count: 1, minutes: 10, label: "supuesto" },
    ],
    source: "Estimación propia del equipo",
    label: "supuesto",
  },
};

const ETA = "2026-10-22T08:00:00-03:00";

function input(overrides: Partial<SummaryInput> & Pick<SummaryInput, "tab" | "rows">): SummaryInput {
  return {
    settings: SETTINGS,
    etaHistories: new Map([
      ["op-4471", [{ eta: ETA, atSim: "2026-10-14T10:30:00-03:00" }]],
      ["op-4472", [{ eta: ETA, atSim: "2026-10-14T10:30:00-03:00" }]],
    ]),
    violations: [],
    denials: [],
    rateCard: [],
    whatsappSimulated: true,
    ...overrides,
  };
}

function kpi(kpis: readonly Kpi[], key: KpiKey): Kpi {
  const found = kpis.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`missing KPI ${key}`);
  return found;
}

function rate(rateId: string, price: number, unit: string) {
  return RateCard.parse({ ...STAMP, rateId, price, unit, source: "https://aws.amazon.com/pricing/", asOf: "2026-09-20", provisional: false });
}

describe("[FL-085] metrics with labels", () => {
  const world = [
    row({ operationId: "op-4471", humanMinutes: 14, interventions: 2, consoleSeconds: 300, completedAtSim: "2026-10-16T09:00:00-03:00", assignmentsTotal: 4, assignmentsCorrect: 3 }),
    row({ operationId: "op-4472", humanMinutes: 6, interventions: 0, consoleSeconds: 60 }),
  ];
  const batch = [
    row({ operationId: "op-7001", source: "BATCH", clockId: "sim-b1", agentMode: "REAL", assignmentsTotal: 2, assignmentsCorrect: 2, violations: 0 }),
    row({ operationId: "op-7002", source: "BATCH", clockId: "sim-b1", agentMode: "SCRIPTED", assignmentsTotal: 5, assignmentsCorrect: 1, violations: 1 }),
  ];
  const all = [...world, ...batch];

  it("[FL-085] keeps every tab to its own source and mode", () => {
    expect(rowsOfTab(all, tabSelector("WORLD", "GLOBAL#firm-delta")).map((item) => item.operationId)).toEqual(["op-4471", "op-4472"]);
    expect(rowsOfTab(all, tabSelector("BATCH_REAL")).map((item) => item.operationId)).toEqual(["op-7001"]);
    expect(rowsOfTab(all, tabSelector("BATCH_SCRIPTED")).map((item) => item.operationId)).toEqual(["op-7002"]);
    expect(rowsOfTab(all, tabSelector("WORLD", "JUDGE#firm-judge-01"))).toEqual([]);
  });

  it("[FL-085] gives each KPI its N, source and label", () => {
    const summary = summarize(input({ tab: "WORLD", rows: world, violations: [], denials: [{ decision: "DENY", ruleIds: ["CP-OPTIN"] }, { decision: "DEFER", ruleIds: ["CP-HOURS-AR"] }] }));
    expect(summary).toMatchObject({ tab: "WORLD", label: "MEASURED", n: 2 });
    expect(kpi(summary.kpis, "humanMinutesPerDossier")).toMatchObject({ value: 10, n: 2, source: "WORLD", label: "ASSUMPTION" });
    expect(kpi(summary.kpis, "manualBaselineMinutes")).toMatchObject({ value: 95, n: 3, source: "FIRM_SETTINGS", label: "ASSUMPTION" });
    expect(kpi(summary.kpis, "consoleMinutesObserved")).toMatchObject({ value: 3, n: 2, label: "MEASURED" });
    expect(kpi(summary.kpis, "interventionsPerDossier")).toMatchObject({ value: 1, n: 2 });
    expect(kpi(summary.kpis, "correctResponsiblePct")).toMatchObject({ value: 75, n: 4 });
    expect(kpi(summary.kpis, "policyViolations")).toMatchObject({ value: 0, source: "AUDIT_LOG", detail: { decisionsByRule: { "CP-OPTIN": { deny: 1, defer: 0 }, "CP-HOURS-AR": { deny: 0, defer: 1 } } } });
  });

  it("[FL-085] counts a dossier complete only 72 h before the ETA in force", () => {
    const late = row({ operationId: "op-4472", completedAtSim: "2026-10-20T09:00:00-03:00" });
    const summary = summarize(input({ tab: "WORLD", rows: [world[0] as DossierKpi, late] }));
    expect(kpi(summary.kpis, "completeBeforeArrivalPct")).toMatchObject({ value: 50, n: 2, detail: { onTime: 1 } });
  });

  it("[FL-085] reads the ETA that was in force when the dossier completed", () => {
    const moved = new Map([["op-4471", [{ eta: ETA, atSim: "2026-10-14T10:30:00-03:00" }, { eta: "2026-10-18T08:00:00-03:00", atSim: "2026-10-15T12:00:00-03:00" }]]]);
    const summary = summarize(input({ tab: "WORLD", rows: [world[0] as DossierKpi], etaHistories: moved }));
    expect(kpi(summary.kpis, "completeBeforeArrivalPct")).toMatchObject({ value: 0, n: 1 });
  });

  it("[FL-085] says 'no aplica' for the correct responsible of the scripted agent", () => {
    const summary = summarize(input({ tab: "BATCH_SCRIPTED", rows: rowsOfTab(all, tabSelector("BATCH_SCRIPTED")) }));
    expect(summary.label).toBe("SCRIPTED_AGENT");
    expect(kpi(summary.kpis, "correctResponsiblePct")).toMatchObject({ value: null, gap: "NOT_APPLICABLE" });
    expect(kpi(summary.kpis, "policyViolations")).toMatchObject({ value: 1, source: "BATCH" });
    expect(summary.kpis.some((item) => item.key === "consoleMinutesObserved")).toBe(false);
  });

  it("[FL-085] shows no cost while a rate is not verified", () => {
    const priced = row({ operationId: "op-4471", inputTokens: 1_000_000, outputTokens: 0, emailSent: 1_000 });
    const unverified = summarize(input({ tab: "WORLD", rows: [priced] }));
    expect(kpi(unverified.kpis, "costPerDossierUsd")).toMatchObject({ value: null, gap: "UNVERIFIED_RATES" });

    const rates = [rate("bedrock:global.anthropic.claude-opus-5:input", 5, "PER_1M_TOKENS"), rate("ses:outbound", 0.1, "PER_1K_MESSAGES")];
    const verified = summarize(input({ tab: "WORLD", rows: [priced], rateCard: rates }));
    expect(kpi(verified.kpis, "costPerDossierUsd")).toMatchObject({ value: 5.1, n: 1 });
  });

  it("[FL-085] reports no data instead of a zero for an empty tab", () => {
    const summary = summarize(input({ tab: "BATCH_REAL", rows: [] }));
    expect(kpi(summary.kpis, "humanMinutesPerDossier")).toMatchObject({ value: null, n: 0, gap: "NO_DATA" });
    expect(kpi(summary.kpis, "completeBeforeArrivalPct")).toMatchObject({ value: null, gap: "NO_DATA" });
  });

  it("[FL-085] exports the rows of a tab as CSV without names or contacts", () => {
    const csv = kpiRowsCsv(world);
    const [header, first] = csv.split("\n");
    expect(header?.startsWith("operationId,clockId,source,agentMode")).toBe(true);
    expect(first?.startsWith("op-4471,GLOBAL#firm-delta,WORLD,REAL")).toBe(true);
    expect(csv).not.toMatch(/@|\+54/);
  });
});
