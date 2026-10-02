// The delay-risk text of `estimate_delay_risk` (docs/tool-catalog.md, CONTEXT.md "Riesgo de demora"):
// what the agent quotes as it is and what the escalation email carries. Every figure is labelled
// "supuesto" and names its source; nothing here is a promise or a fact. Spanish for the importer and
// the firm; the English gloss is what the phone simulator shows next to it. No `Intl`: the seed
// imports these texts and must write the same bytes on every machine.
import type { DocType } from "@legajo/shared";
import { missingDocumentsEsAR } from "./es-AR";
import { joinList } from "./helpers";

export interface RiskTextParams {
  readonly missing: readonly DocType[];
  readonly daysAtRisk: { readonly min: number; readonly max: number };
  readonly estimatedCostUsd: { readonly min: number; readonly max: number };
  readonly freeDaysAtPort: number;
  readonly demurrageUsdPerDay: { readonly min: number; readonly max: number };
  /** `FirmSettings.assumptions.source` ("fuentes secundarias no verificadas"). */
  readonly source: string;
}

/** "1.080" (es) or "1,080" (en): whole dollars and days, grouped by thousands. */
export function groupThousands(value: number, separator: "." | ","): string {
  const digits = String(Math.round(Math.abs(value)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return value < 0 ? `-${grouped}` : grouped;
}

function rangeEs(min: number, max: number, unit: (value: string) => string): string {
  return min === max ? unit(groupThousands(min, ".")) : `de ${unit(groupThousands(min, "."))} a ${unit(groupThousands(max, "."))}`;
}

function rangeEn(min: number, max: number, unit: (value: string) => string): string {
  return min === max ? unit(groupThousands(min, ",")) : `${unit(groupThousands(min, ","))} to ${unit(groupThousands(max, ","))}`;
}

function assumptionsEs(p: RiskTextParams): string {
  const demurrage = `USD ${groupThousands(p.demurrageUsdPerDay.min, ".")}-${groupThousands(p.demurrageUsdPerDay.max, ".")}`;
  return `Supuestos: ${p.freeDaysAtPort} días libres en puerto y ${demurrage} por día de demora de contenedor (supuesto; fuente: ${p.source}).`;
}

/** Spanish text: the word "supuesto" and the source are always there, complete or not. */
export function riskTextEsAR(p: RiskTextParams): string {
  if (p.missing.length === 0) return `El legajo está completo: sin días en riesgo de demora por documentación. ${assumptionsEs(p)}`;
  const days = rangeEs(p.daysAtRisk.min, p.daysAtRisk.max, (value) => `${value} días`);
  const cost = rangeEs(p.estimatedCostUsd.min, p.estimatedCostUsd.max, (value) => `USD ${value}`);
  return `Riesgo estimado (supuesto): faltan ${missingDocumentsEsAR(p.missing)}; ${days} de demora y ${cost} de costo. ${assumptionsEs(p)}`;
}

const DOC_EN: Readonly<Record<DocType, string>> = {
  COMMERCIAL_INVOICE: "commercial invoice",
  PACKING_LIST: "packing list",
  CERTIFICATE_OF_ORIGIN: "certificate of origin",
};

/** English gloss of `riskTextEsAR` (phone simulator). */
export function riskTextEn(p: RiskTextParams): string {
  const assumptions = `Assumptions: ${p.freeDaysAtPort} free days at port and USD ${groupThousands(p.demurrageUsdPerDay.min, ",")}-${groupThousands(p.demurrageUsdPerDay.max, ",")} per day of container demurrage (assumption; source: ${p.source}).`;
  if (p.missing.length === 0) return `The dossier is complete: no days at risk of delay from documents. ${assumptions}`;
  const days = rangeEn(p.daysAtRisk.min, p.daysAtRisk.max, (value) => `${value} days`);
  const cost = rangeEn(p.estimatedCostUsd.min, p.estimatedCostUsd.max, (value) => `USD ${value}`);
  return `Estimated risk (assumption): missing ${joinList(p.missing.map((docType) => DOC_EN[docType]), "and")}; ${days} of delay and ${cost} of cost. ${assumptions}`;
}
