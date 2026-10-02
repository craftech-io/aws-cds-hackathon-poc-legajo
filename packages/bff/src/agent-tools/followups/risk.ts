// `estimate_delay_risk` (docs/tool-catalog.md, CONTEXT.md "Riesgo de demora"): the risk of arriving
// without the documents, computed in code from the firm's labelled assumptions and never from what the
// model wrote (`overrideAssumptions` does not exist past zod). The same estimate goes into the
// escalation email (escalations/) and the at-risk mark of the `ARRIVAL` milestone.
//
//   missing            every document that is not `VALID` (a waived observation already made it VALID)
//   hoursToEta         from the simulated now of the call to the ETA in force (negative once arrived)
//   daysWithoutDocs    whole simulated days the missing documents have been missing (since the dossier
//                      opened, at least 1): the estimate assumes they take at most that long again once
//                      the cargo is at port
//   daysAtRisk         0 when complete; otherwise from max(0, daysWithoutDocs − freeDaysAtPort) to
//                      daysWithoutDocs
//   estimatedCostUsd   daysAtRisk × the demurrage range per day
import type { DocType } from "@legajo/shared";
import { riskTextEsAR } from "../../copy/risk";
import type { Document } from "../../domain/documents";
import type { FirmSettings } from "../../domain/firms";
import type { Operation } from "../../domain/operations";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface RiskAssumption {
  readonly name: "freeDaysAtPort" | "demurrageUsdPerDay";
  readonly value: string;
  readonly label: "supuesto";
  readonly source: string;
}

export interface DelayRisk {
  readonly missing: readonly DocType[];
  readonly hoursToEta: number;
  readonly daysAtRisk: Range;
  readonly estimatedCostUsd: Range;
  readonly assumptions: readonly RiskAssumption[];
  /** Spanish, with the word "supuesto" and the source: the agent quotes it as it is. */
  readonly text: string;
}

export interface RiskInput {
  readonly operation: Pick<Operation, "eta" | "openedAtSim">;
  readonly documents: readonly Pick<Document, "docType" | "status">[];
  readonly assumptions: FirmSettings["assumptions"];
  /** Simulated now of the call (the turn's event, or the world's now). */
  readonly nowSim: string;
}

const DOC_ORDER: readonly DocType[] = ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"];

/** Documents still owed, in the fixed order of the checklist. */
export function missingDocuments(documents: readonly Pick<Document, "docType" | "status">[]): DocType[] {
  const notValid = new Set(documents.filter((document) => document.status !== "VALID").map((document) => document.docType));
  return DOC_ORDER.filter((docType) => notValid.has(docType));
}

export function estimateDelayRisk(input: RiskInput): DelayRisk {
  const { assumptions } = input;
  const now = Date.parse(input.nowSim);
  const missing = missingDocuments(input.documents);
  const hoursToEta = Math.round(((Date.parse(input.operation.eta) - now) / HOUR_MS) * 10) / 10;
  const daysWithoutDocs = missing.length === 0 ? 0 : Math.max(1, Math.ceil((now - Date.parse(input.operation.openedAtSim)) / DAY_MS));
  const daysAtRisk: Range = { min: Math.max(0, daysWithoutDocs - assumptions.freeDaysAtPort), max: daysWithoutDocs };
  const perDay = assumptions.demurrageUsdPerDay;
  const estimatedCostUsd: Range = { min: daysAtRisk.min * perDay.min, max: daysAtRisk.max * perDay.max };
  return {
    missing,
    hoursToEta,
    daysAtRisk,
    estimatedCostUsd,
    assumptions: [
      { name: "freeDaysAtPort", value: String(assumptions.freeDaysAtPort), label: assumptions.label, source: assumptions.source },
      { name: "demurrageUsdPerDay", value: `USD ${perDay.min}-${perDay.max}`, label: assumptions.label, source: assumptions.source },
    ],
    text: riskTextEsAR({ missing, daysAtRisk, estimatedCostUsd, freeDaysAtPort: assumptions.freeDaysAtPort, demurrageUsdPerDay: perDay, source: assumptions.source }),
  };
}
