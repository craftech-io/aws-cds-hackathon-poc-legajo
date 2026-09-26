// Test support for copy/: sample parameters (from the main story of the seed, operation 4471), a
// renderer that lists every text of the folder, and a rough language check. Not imported by runtime code.
import { STAGE_DOMAIN, SupplierEmailKind, WhatsAppTemplateName } from "@legajo/shared";
import { BUTTON_LABELS } from "./buttons";
import { CONSENT_MEDIUM_LABELS, CONSENT_TEXT_VERSIONS, consentText } from "./consent";
import { DISPATCH_GLOSSARY, DISPATCH_GLOSSARY_KEYS } from "./dispatch-glossary";
import { labelsEn, supplierEmailEn } from "./en";
import { BUTTON_GLOSS, CONSENT_GLOSS, DISPATCH_GLOSS, firmGloss, glossTemplate, importerGloss } from "./en-gloss";
import { supplierSimEn } from "./en-supplier-sim";
import { importerEsAR, labelsEsAR } from "./es-AR";
import { firmEsAR } from "./es-AR-firm";
import { OBSERVATION_LABELS } from "./observation-labels";
import { TEMPLATES, renderTemplate } from "./templates";
import type { EscalationEmailParams, FirmTexts, ImporterTexts, Labels, ReadyForReviewEmailParams } from "./types";

const consoleUrl = `https://${STAGE_DOMAIN}/app/operations/op-4471`;

const escalation: EscalationEmailParams = {
  operationNumber: "4471",
  importerName: "Norpampa Insumos SRL",
  supplierName: "Qingdao Bluewave Textiles Co., Ltd.",
  reason: "MISSING_AT_ETA_48H",
  summary: "El proveedor no contestó el pedido ni los dos recordatorios.",
  dossierStatus: "OPEN",
  etaText: "22/10 08:00",
  documents: [
    { docType: "COMMERCIAL_INVOICE", status: "VALID" },
    { docType: "PACKING_LIST", status: "WITH_OBSERVATION", responsible: "SUPPLIER" },
    { docType: "CERTIFICATE_OF_ORIGIN", status: "MISSING", responsible: "SUPPLIER" },
  ],
  attempts: [
    { atText: "15/10 10:00", channel: "WHATSAPP", recipient: "IMPORTER", kind: "DOCS_REQUEST" },
    { atText: "15/10 22:00", channel: "EMAIL", recipient: "SUPPLIER", kind: "DOCS_REQUEST" },
  ],
  riskText: "De 0 a 3 días en riesgo, USD 0 a 540 (supuesto: 5 días libres en puerto y USD 160-180 por día; fuentes secundarias no verificadas).",
  consoleUrl,
};

const ready: ReadyForReviewEmailParams = {
  operationNumber: "4471",
  importerName: "Norpampa Insumos SRL",
  supplierName: "Qingdao Bluewave Textiles Co., Ltd.",
  summary: "Packing list: el proveedor corrigió el peso bruto en la versión 2.",
  consoleUrl,
};

export const SAMPLE = {
  maskedEmail: "s•••@sim.legajo.demo.craftech.io",
  row: { supplierName: "Qingdao Bluewave Textiles Co., Ltd.", etaText: "22/10" },
  escalation,
  ready,
} as const;

export function importerTexts(pack: ImporterTexts): Record<string, string> {
  return {
    guardrailRefusal: pack.guardrailRefusal,
    unknownSender: pack.unknownSender,
    rateLimited: pack.rateLimited,
    rejectedMedia: pack.rejectedMedia,
    mediaTooLarge: pack.mediaTooLarge,
    optOutConfirmation: pack.optOutConfirmation,
    questionPrompt: pack.questionPrompt,
    contactConfirmation: pack.contactConfirmation({ maskedEmail: SAMPLE.maskedEmail }),
    operationChoiceBody: pack.operationChoice.body,
    operationChoiceRow: pack.operationChoice.rowDescription(SAMPLE.row),
  };
}

export function firmTexts(pack: FirmTexts): Record<string, string> {
  const escalationEmail = pack.escalationEmail(escalation);
  const readyEmail = pack.readyForReviewEmail(ready);
  return {
    escalationSubject: escalationEmail.subject,
    escalationBody: escalationEmail.body,
    readySubject: readyEmail.subject,
    readyBody: readyEmail.body,
    promptAttack: pack.guardrailSummary.promptAttack,
    cardData: pack.guardrailSummary.cardData,
  };
}

function labelTexts(prefix: string, labels: Labels, out: Map<string, string>): void {
  for (const [group, record] of Object.entries(labels)) {
    for (const [key, text] of Object.entries(record as Record<string, string>)) out.set(`${prefix}.${group}.${key}`, text);
  }
}

function addAll(prefix: string, record: Record<string, string>, out: Map<string, string>): void {
  for (const [key, text] of Object.entries(record)) out.set(`${prefix}.${key}`, text);
}

/** Every text of copy/ rendered with the samples, keyed by where it comes from. */
export function allTexts(): Map<string, string> {
  const out = new Map<string, string>();
  labelTexts("labelsEsAR", labelsEsAR, out);
  labelTexts("labelsEn", labelsEn, out);
  addAll("importerEsAR", importerTexts(importerEsAR), out);
  addAll("importerGloss", importerTexts(importerGloss), out);
  addAll("firmEsAR", firmTexts(firmEsAR), out);
  addAll("firmGloss", firmTexts(firmGloss), out);
  for (const name of WhatsAppTemplateName.options) {
    const examples = TEMPLATES[name].params.map((param) => param.example);
    const hasUrl = TEMPLATES[name].buttons.some((button) => button.type === "URL");
    out.set(`template.${name}`, renderTemplate(name, examples, hasUrl ? "sample-token" : undefined).body);
    out.set(`templateGloss.${name}`, glossTemplate(name, examples));
  }
  for (const [action, label] of Object.entries(BUTTON_LABELS)) {
    out.set(`button.${action}.template`, label.template);
    out.set(`button.${action}.interactive`, label.interactive);
  }
  addAll("buttonGloss", BUTTON_GLOSS, out);
  for (const version of CONSENT_TEXT_VERSIONS) {
    out.set(`consent.${version}`, consentText(version, { firmName: "Estudio Delta" }));
    out.set(`consentGloss.${version}`, CONSENT_GLOSS[version]({ firmName: "Estudio Delta" }));
  }
  addAll("consentMedium", CONSENT_MEDIUM_LABELS, out);
  for (const key of DISPATCH_GLOSSARY_KEYS) {
    addAll(`dispatch.${key}`, { ...DISPATCH_GLOSSARY[key] }, out);
    addAll(`dispatchGloss.${key}`, { ...DISPATCH_GLOSS[key] }, out);
  }
  for (const [code, label] of Object.entries(OBSERVATION_LABELS)) addAll(`observation.${code}`, { ...label }, out);
  const subject = { operationNumber: "4471", invoiceNumber: "QBT-2026-0917", docTypes: ["PACKING_LIST"] as const };
  for (const kind of SupplierEmailKind.options) {
    const observation = kind === "CORRECTION_REQUEST" ? { code: "GROSS_WEIGHT_MISMATCH", docType: "PACKING_LIST" } as const : undefined;
    out.set(`supplierSubject.${kind}`, supplierEmailEn.subject(kind, { ...subject, observation }));
  }
  out.set("supplierDisplayName", supplierEmailEn.displayName("Estudio Delta"));
  const reply = { subject: "[Op 4471] Missing documents: packing list", docTypes: ["PACKING_LIST"] as const, invoiceNumber: "QBT-2026-0917", supplierName: "Qingdao Bluewave Textiles Co., Ltd." };
  const sim = {
    documentsAttached: supplierSimEn.documentsAttached(reply),
    correctedAttached: supplierSimEn.correctedAttached(reply),
    promise: supplierSimEn.promise(reply),
    autoReply: supplierSimEn.autoReply(reply),
  };
  for (const [key, text] of Object.entries(sim)) addAll(`sim.${key}`, { ...text }, out);
  return out;
}

// Function words of each language, without the ones they share ("no", "a").
const SPANISH_WORDS = /(?<!\p{L})(el|la|los|las|de|del|que|y|por|con|para|tu|te|un|una|es|está|hola|nos|lo|le|se|más)(?!\p{L})/giu;
const ENGLISH_WORDS = /(?<!\p{L})(the|to|and|of|your|we|is|are|for|you|it|in|this|with|an|from|not|or|will|be|any)(?!\p{L})/giu;
const SPANISH_MARKS = /[¿¡ñáéíóú]/i;

function hits(pattern: RegExp, text: string): number {
  return text.match(pattern)?.length ?? 0;
}

/** More Spanish function words than English ones. Rough on purpose: it only has to tell es from en. */
export function looksSpanish(text: string): boolean {
  return hits(SPANISH_WORDS, text) > hits(ENGLISH_WORDS, text);
}

/** More English function words than Spanish ones, and no Spanish-only marks. */
export function looksEnglish(text: string): boolean {
  return !SPANISH_MARKS.test(text) && hits(ENGLISH_WORDS, text) > hits(SPANISH_WORDS, text);
}
