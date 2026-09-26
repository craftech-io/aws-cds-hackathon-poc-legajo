// `Reference` (docs/seed-spec.md §12): holidays checked against the official calendar, the eight
// WhatsApp templates, the rate card (provisional until WP-41), the customs-status glossary, the
// observation labels, the evaluation truth of every seeded observation and the name checks. Every
// text comes from packages/bff/src/copy/, never written twice.
import { WhatsAppTemplateName, observationId, operationId as opId } from "@legajo/shared";
import { DISPATCH_GLOSSARY, DISPATCH_GLOSSARY_KEYS } from "@legajo/bff/copy/dispatch-glossary";
import { DISPATCH_GLOSS, TEMPLATE_GLOSS } from "@legajo/bff/copy/en-gloss";
import { OBSERVATION_LABELS } from "@legajo/bff/copy/observation-labels";
import { TEMPLATES } from "@legajo/bff/copy/templates";
import { SES_OUTBOUND_RATE_KEY, bedrockRateKey, whatsappRateKey } from "@legajo/bff/services/ratecard";
import { ObservationCode } from "@legajo/shared";
import { CHECKED_AT } from "../lib/constants";
import { templateItem, type SeedItem } from "../lib/items";
import { OPERATIONS } from "./catalog-operations";
import { NAME_CHECKS } from "./namecheck";

/** Official calendar of Argentina (argentina.gob.ar, dataset of the 2026 holidays page), checked on CHECKED_AT. */
export const HOLIDAY_SOURCE = "https://www.argentina.gob.ar/sites/default/files/holidays-2026-es.json";

/**
 * National holidays of October to December 2026 (§12). The same calendar lists 07/12 as a "día no
 * laborable con fines turísticos", which is not a national holiday and does not close CP-HOURS-AR.
 */
export const HOLIDAYS_AR: readonly { readonly date: string; readonly name: string }[] = [
  { date: "2026-10-12", name: "Día de la Raza" },
  { date: "2026-11-23", name: "Día de la Soberanía Nacional (trasladado del 20/11)" },
  { date: "2026-12-08", name: "Inmaculada Concepción de María" },
  { date: "2026-12-25", name: "Navidad" },
];

function holidays(): SeedItem[] {
  return HOLIDAYS_AR.map((holiday) => templateItem("Holiday", { country: "AR", date: holiday.date, name: holiday.name, verified: true, verifiedAt: CHECKED_AT, source: HOLIDAY_SOURCE }));
}

function templates(): SeedItem[] {
  return WhatsAppTemplateName.options.map((name) => {
    const template = TEMPLATES[name];
    return templateItem("Template", {
      name,
      language: template.language,
      category: template.category,
      body: template.body,
      paramCount: template.params.length,
      buttons: template.buttons.map((button) => ({ type: button.type, text: button.text, action: button.action, ...(button.type === "URL" ? { url: button.url } : {}) })),
      status: "LOCAL_ONLY",
      gloss: TEMPLATE_GLOSS[name],
    });
  });
}

/** Rate rows are seeded without price and `provisional` (WP-41 loads verified prices with source and date). */
function rateCard(): SeedItem[] {
  const rows: { rateId: string; unit: string }[] = [
    ...(["input", "output", "cacheRead", "cacheWrite"] as const).map((kind) => ({ rateId: bedrockRateKey(kind), unit: "PER_1M_TOKENS" })),
    { rateId: SES_OUTBOUND_RATE_KEY, unit: "PER_1K_MESSAGES" },
    { rateId: whatsappRateKey("utility"), unit: "PER_MESSAGE" },
    { rateId: whatsappRateKey("service"), unit: "PER_MESSAGE" },
  ];
  return rows.map((row) => templateItem("RateCard", { rateId: row.rateId, price: null, unit: row.unit, currency: "USD", provisional: true }));
}

function glossary(): SeedItem[] {
  return DISPATCH_GLOSSARY_KEYS.map((key) => {
    const [status, channel] = key.split("#");
    return templateItem("DispatchGlossary", { status, ...(channel === undefined ? {} : { channel }), text: DISPATCH_GLOSSARY[key].explanation, gloss: DISPATCH_GLOSS[key].explanation });
  });
}

function observationCodes(): SeedItem[] {
  return ObservationCode.options.map((code) => templateItem("ObservationCode", { code, labelEs: OBSERVATION_LABELS[code].es, labelEn: OBSERVATION_LABELS[code].en }));
}

/** One row per seeded observation of a model operation; clones inherit their model's (§9, §14). */
function evalTruth(): SeedItem[] {
  return OPERATIONS.flatMap((operation) => {
    if (operation.error === undefined) return [];
    const id = opId(operation.number);
    const { docType, code, expectedResponsible } = operation.error;
    return [templateItem("EvalTruth", { operationId: id, observationId: observationId(id, docType, code), docType, code, expectedResponsible })];
  });
}

function nameChecks(): SeedItem[] {
  return NAME_CHECKS.map((check) => templateItem("NameCheck", { name: check.name, kind: check.kind, query: check.query, checkedAt: CHECKED_AT, result: check.result }));
}

export function referenceItems(): SeedItem[] {
  return [...holidays(), ...templates(), ...rateCard(), ...glossary(), ...observationCodes(), ...evalTruth(), ...nameChecks()];
}
