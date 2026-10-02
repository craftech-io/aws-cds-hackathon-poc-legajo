import { describe, expect, it } from "vitest";
import { followupsWorld } from "./testing";
import { estimateDelayRisk } from "./risk";

const ASSUMPTIONS = { freeDaysAtPort: 5, demurrageUsdPerDay: { min: 160, max: 180 }, source: "Fuentes secundarias no verificadas", label: "supuesto" as const };
const OPERATION = { eta: "2026-10-22T08:00:00-03:00", openedAtSim: "2026-10-14T10:30:00-03:00" };

describe("estimate_delay_risk [FL-052]", () => {
  it("[FL-052] a complete dossier: 0 days, 0 USD, and the text still labels the assumptions", () => {
    const risk = estimateDelayRisk({ operation: OPERATION, documents: [{ docType: "COMMERCIAL_INVOICE", status: "VALID" }, { docType: "PACKING_LIST", status: "VALID" }, { docType: "CERTIFICATE_OF_ORIGIN", status: "VALID" }], assumptions: ASSUMPTIONS, nowSim: "2026-10-20T10:00:00-03:00" });
    expect(risk).toMatchObject({ missing: [], daysAtRisk: { min: 0, max: 0 }, estimatedCostUsd: { min: 0, max: 0 } });
    expect(risk.text).toContain("supuesto");
    expect(risk.text).toContain("Fuentes secundarias no verificadas");
  });

  it("[FL-052] incomplete: from max(0, days without documents − free days) to the days without documents, at the demurrage range", () => {
    const documents = [{ docType: "COMMERCIAL_INVOICE", status: "VALID" }, { docType: "PACKING_LIST", status: "WITH_OBSERVATION" }, { docType: "CERTIFICATE_OF_ORIGIN", status: "MISSING" }] as const;
    const early = estimateDelayRisk({ operation: OPERATION, documents, assumptions: ASSUMPTIONS, nowSim: "2026-10-17T10:30:00-03:00" });
    expect(early).toMatchObject({ missing: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"], daysAtRisk: { min: 0, max: 3 }, estimatedCostUsd: { min: 0, max: 540 }, hoursToEta: 117.5 });
    const late = estimateDelayRisk({ operation: OPERATION, documents, assumptions: ASSUMPTIONS, nowSim: "2026-10-22T08:00:00-03:00" });
    expect(late).toMatchObject({ daysAtRisk: { min: 3, max: 8 }, estimatedCostUsd: { min: 480, max: 1440 }, hoursToEta: 0 });
    expect(late.text).toBe(
      "Riesgo estimado (supuesto): faltan packing list y certificado de origen; de 3 días a 8 días de demora y de USD 480 a USD 1.440 de costo. Supuestos: 5 días libres en puerto y USD 160-180 por día de demora de contenedor (supuesto; fuente: Fuentes secundarias no verificadas).",
    );
    expect(late.assumptions.every((assumption) => assumption.label === "supuesto" && assumption.source === ASSUMPTIONS.source)).toBe(true);
  });

  it("[FL-052] through the tool: the figures are in the result the turn grounds on", async () => {
    const world = await followupsWorld();
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    const answer = await world.target.invoke("estimate_delay_risk", { sessionToken: turn.token });
    expect(answer).toMatchObject({ ok: true, missing: ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"], daysAtRisk: { min: 0, max: 1 } });
    const results = await world.stores.connector.runtime.listTurnResults(turn.turnId);
    expect(results.map((result) => result.tool)).toEqual(["estimate_delay_risk"]);
  });

  it("[FL-052] overrideAssumptions with any value is refused (LAM-STRICT, CED-RISK-ASSUMPTIONS)", async () => {
    const world = await followupsWorld();
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    for (const value of [{ freeDaysAtPort: 30 }, {}, null]) {
      expect(await world.target.invoke("estimate_delay_risk", { sessionToken: turn.token, overrideAssumptions: value })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    }
  });
});
