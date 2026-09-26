import { describe, expect, it } from "vitest";
import { type KpiView, type MetricsSummary, baselineOf, decisionsByRuleOf, kpiCard, kpiCards, summaryLine } from "./metrics-model";

function kpi(overrides: Partial<KpiView> & Pick<KpiView, "key">): KpiView {
  return { value: 1, n: 3, source: "WORLD", label: "MEASURED", ...overrides } as KpiView;
}

const SUMMARY: MetricsSummary = {
  clockId: "GLOBAL#firm-delta",
  tab: "WORLD",
  label: "MEASURED",
  n: 3,
  kpis: [
    kpi({ key: "humanMinutesPerDossier", value: 12.5, label: "ASSUMPTION" }),
    kpi({
      key: "manualBaselineMinutes",
      value: 64,
      n: 1,
      source: "FIRM_SETTINGS",
      label: "ASSUMPTION",
      detail: { breakdown: [{ action: "Contactos por legajo", count: 8, minutes: 8 }], basis: "Estimación propia del equipo" },
    }),
    kpi({ key: "policyViolations", value: 0, source: "AUDIT_LOG", detail: { decisionsByRule: { "CP-HOURS-SUPPLIER": { deny: 0, defer: 2 } } } }),
    kpi({ key: "costPerDossierUsd", value: null, gap: "UNVERIFIED_RATES", detail: { missingRates: ["bedrock-input", "bedrock-output"], whatsappPricedAsLive: true } }),
    kpi({ key: "latencyP95Ms", value: 12_340 }),
    kpi({ key: "completeBeforeArrivalPct", value: 66.7 }),
  ],
} as MetricsSummary;

describe("KPI tiles with N, source and label", () => {
  it("formats each value in its unit and says N, source and label on every tile", () => {
    const cards = kpiCards(SUMMARY);
    expect(cards.map((card) => card.valueText)).toEqual(["12,5 min", "64,0 min", "0", "sin tarifa verificada", "12,3 s", "66,7 %"]);
    expect(cards[0]?.hint).toBe("N = 3 · fuente: este mundo · supuesto");
    expect(cards[1]?.hint).toBe("N = 1 · fuente: configuración del estudio · supuesto");
    expect(cards[2]?.hint).toBe("N = 3 · fuente: bitácora · medido");
  });

  it("marks the violations counter green at 0 and red otherwise", () => {
    expect(kpiCard(kpi({ key: "policyViolations", value: 0 })).tone).toBe("success");
    expect(kpiCard(kpi({ key: "policyViolations", value: 2 })).tone).toBe("danger");
  });

  it("says why a number is missing, never a zero", () => {
    expect(kpiCard(kpi({ key: "correctResponsiblePct", value: null, n: 0, gap: "NOT_APPLICABLE", label: "SCRIPTED_AGENT", source: "BATCH" }))).toMatchObject({
      valueText: "no aplica",
      hint: "N = 0 · fuente: lote de métricas · agente guionado",
      notes: ["Con agente guionado no se compara la asignación con la verdad de base."],
    });
    expect(kpiCard(kpi({ key: "interventionsPerDossier", value: null, n: 0, gap: "NO_DATA" })).valueText).toBe("sin datos");
  });

  it("notes that WhatsApp is valued as live and which rates are still to verify", () => {
    const cost = kpiCards(SUMMARY).find((card) => card.key === "costPerDossierUsd");
    expect(cost?.notes).toEqual(["WhatsApp corre en modo simulado: cada mensaje se valoriza como si fuera vivo.", "Faltan verificar 2 tarifas."]);
    expect(kpiCard(kpi({ key: "costPerDossierUsd", value: 0.4213 })).valueText).toBe("USD 0,4213");
  });
});

describe("baseline and decisions behind the numbers", () => {
  it("shows the declared manual baseline as its breakdown", () => {
    expect(baselineOf(SUMMARY)).toEqual({ rows: [{ action: "Contactos por legajo", count: 8, minutes: 8 }], totalMinutes: 64, basis: "Estimación propia del equipo" });
    expect(baselineOf({ kpis: [] })).toBeUndefined();
  });

  it("reads the DENY and DEFER by rule of the violations KPI, none for a batch tab", () => {
    expect(decisionsByRuleOf(SUMMARY)).toEqual({ "CP-HOURS-SUPPLIER": { deny: 0, defer: 2 } });
    expect(decisionsByRuleOf({ kpis: [kpi({ key: "policyViolations", value: 0, source: "BATCH" })] })).toEqual({});
  });

  it("sums the tab up with its N and label", () => {
    expect(summaryLine(SUMMARY)).toBe("N = 3 legajos · medido");
    expect(summaryLine({ n: 1, label: "SCRIPTED_AGENT" })).toBe("N = 1 legajo · agente guionado");
  });
});
