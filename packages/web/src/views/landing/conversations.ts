// The story of operation 4471 as the parties read it (docs/landing-spec.md §1.4), built from the real
// texts of packages/bff/src/copy: every WhatsApp template is rendered by `renderTemplate`, every fixed
// text and button comes from the importer pack and its English gloss, the supplier subjects from the
// English texts, the firm's escalation email from its Spanish texts, and the simulated supplier's
// replies from supplier-replies.json, which
// scripts/landing/supplier-replies.ts writes from copy/en-supplier-sim.ts (that module also carries the
// hostile bodies of the injection behaviour, which never ship in the public page; landing.test.ts
// fails if the file drifts). Only what the model writes in a real turn (a free reply to the importer,
// the body of an email to the supplier) is an example written here, and the landing labels it so. All
// names are the fictitious ones of docs/seed-spec.md.
import { type DocType, STAGE_DOMAIN, type WaButtonAction, type WhatsAppTemplateName, maskEmail } from "@legajo/shared";
import { BUTTON_LABELS } from "@legajo/bff/copy/buttons";
import { DISPATCH_GLOSSARY } from "@legajo/bff/copy/dispatch-glossary";
import { labelsEn, supplierEmailEn } from "@legajo/bff/copy/en";
import { BUTTON_GLOSS, DISPATCH_GLOSS, glossTemplate, importerGloss } from "@legajo/bff/copy/en-gloss";
import { docTypeOfEsAR, importerEsAR, missingDocumentsEsAR } from "@legajo/bff/copy/es-AR";
import { joinList } from "@legajo/bff/copy/helpers";
import { firmEsAR } from "@legajo/bff/copy/es-AR-firm";
import { OBSERVATION_LABELS } from "@legajo/bff/copy/observation-labels";
import { TEMPLATES, renderTemplate } from "@legajo/bff/copy/templates";
import { z } from "zod";
import supplierReplies from "./supplier-replies.json" with { type: "json" };

/** Facts of the main story (docs/seed-spec.md §7, `op-4471`), all fictitious. */
export const STORY = {
  firmName: "Estudio Delta",
  importerName: "Norpampa Insumos SRL",
  operationNumber: "4471",
  vessel: "Austral Aurora",
  etaText: "22/10",
  newEtaText: "20/10",
  newDeadlineText: "17/10 10:00",
  invoiceNumber: "QBT-2026-0917",
  supplierName: "Qingdao Bluewave Textiles Co., Ltd.",
  supplierAddress: "supplier-qingdao@sim.legajo.demo.craftech.io",
  threadAddress: "op-4471-k7p2q9@legajo.demo.craftech.io",
  missing: ["CERTIFICATE_OF_ORIGIN", "PACKING_LIST"] as const satisfies readonly DocType[],
  grossWeightKg: { found: 12_480, expected: 12_840 },
} as const;

/** Stands in for the upload token of the template's URL button; the landing never shows the URL. */
const EXAMPLE_UPLOAD_TOKEN = "ejemplo";

/** Who wrote a message: a Meta-approved template, a fixed text of the code, an example of what the agent writes, or the importer. */
export type WaSource = "template" | "fixed" | "agent" | "importer";

export interface WaButtonView {
  readonly text: string;
  readonly gloss: string;
  readonly url: boolean;
}

export interface WaMessageView {
  readonly from: "firm" | "importer";
  /** What the importer reads, in Rioplatense Spanish. */
  readonly text: string;
  /** Its fixed English gloss (packages/bff/src/copy/en-gloss.ts), or the example's own translation. */
  readonly gloss: string;
  /** Simulated time in Argentina. */
  readonly time: string;
  readonly source: WaSource;
  readonly buttons: readonly WaButtonView[];
  /** The importer tapped a button of the message before (its bubble repeats the button's text). */
  readonly tap: boolean;
}

export const CONVERSATION_IDS = ["request", "delegate", "noAction", "question", "eta", "approval"] as const;
export type ConversationId = (typeof CONVERSATION_IDS)[number];

export interface ConversationView {
  readonly id: ConversationId;
  /** Simulated day of the thread, as WhatsApp heads it. */
  readonly day: string;
  readonly messages: readonly WaMessageView[];
}

function button(action: WaButtonAction, kind: "template" | "interactive", url = false): WaButtonView {
  return { text: BUTTON_LABELS[action][kind], gloss: BUTTON_GLOSS[action], url };
}

/**
 * A template as the importer reads it. `glossParams` are the English values of the parameters that are
 * words (a document, a field, a customs status): the gloss never carries a Spanish parameter.
 */
export function templateMessage(name: WhatsAppTemplateName, params: readonly string[], time: string, glossParams: readonly string[] = params): WaMessageView {
  const hasUrl = TEMPLATES[name].buttons.some((candidate) => candidate.type === "URL");
  const rendered = renderTemplate(name, params, hasUrl ? EXAMPLE_UPLOAD_TOKEN : undefined);
  return {
    from: "firm",
    text: rendered.body,
    gloss: glossTemplate(name, glossParams),
    time,
    source: "template",
    buttons: rendered.buttons.map((item) => ({ ...button(item.action, "template", item.type === "URL"), text: item.text })),
    tap: false,
  };
}

function tap(action: WaButtonAction, kind: "template" | "interactive", time: string): WaMessageView {
  const label = button(action, kind);
  return { from: "importer", text: label.text, gloss: label.gloss, time, source: "importer", buttons: [], tap: true };
}

function importerText(text: string, gloss: string, time: string): WaMessageView {
  return { from: "importer", text, gloss, time, source: "importer", buttons: [], tap: false };
}

function firmText(source: "fixed" | "agent", text: string, gloss: string, time: string, buttons: readonly WaButtonView[] = []): WaMessageView {
  return { from: "firm", text, gloss, time, source, buttons, tap: false };
}

/** "el peso bruto del packing list": what the supplier has to correct, as the template names it. */
export const CORRECTION_TARGET = `${OBSERVATION_LABELS.GROSS_WEIGHT_MISMATCH.esField} ${docTypeOfEsAR.PACKING_LIST}`;
/** The same target in the English gloss: "the gross weight of the packing list". */
export const CORRECTION_TARGET_EN = `the ${OBSERVATION_LABELS.GROSS_WEIGHT_MISMATCH.enSubject} of the ${labelsEn.docType.PACKING_LIST}`;
/** What is missing, in the English gloss of the first request. */
const MISSING_EN = joinList(
  STORY.missing.map((docType) => labelsEn.docType[docType]),
  "and",
);

const MASKED_SUPPLIER = maskEmail(STORY.supplierAddress);
const NARANJA = DISPATCH_GLOSSARY["CANAL_ASIGNADO#NARANJA"];
const LIBERADO = DISPATCH_GLOSSARY.LIBERADO;
const NARANJA_EN = DISPATCH_GLOSS["CANAL_ASIGNADO#NARANJA"];
const LIBERADO_EN = DISPATCH_GLOSS.LIBERADO;

/** What the model writes in these turns, as an example; a real turn writes its own words. */
const AGENT_EXAMPLES = {
  deferred: {
    es: "Listo. Le escribimos al proveedor a primera hora de Qingdao: el email sale hoy a las 22:00 de Argentina (16/10 09:00 allá).",
    en: "Done. We will write to the supplier first thing in the morning in Qingdao: the email goes out today at 22:00 Argentina time (16/10 09:00 there).",
  },
  arrived: {
    es: "Llegaron el certificado de origen y el packing list corregido. El legajo de la operación 4471 ya está completo para que lo revise el estudio.",
    en: "The certificate of origin and the corrected packing list arrived. The file of operation 4471 is complete for the firm to review.",
  },
} as const;

const CONVERSATIONS: Readonly<Record<ConversationId, ConversationView>> = {
  request: {
    id: "request",
    day: "15/10",
    messages: [
      templateMessage("legajo_docs_pendientes", [STORY.firmName, STORY.operationNumber, STORY.vessel, STORY.etaText, missingDocumentsEsAR(STORY.missing)], "10:00", [
        STORY.firmName,
        STORY.operationNumber,
        STORY.vessel,
        STORY.etaText,
        MISSING_EN,
      ]),
    ],
  },
  delegate: {
    id: "delegate",
    day: "15/10",
    messages: [
      tap("SUPPLIER_SENDS", "template", "10:00"),
      firmText("fixed", importerEsAR.contactConfirmation({ maskedEmail: MASKED_SUPPLIER }), importerGloss.contactConfirmation({ maskedEmail: MASKED_SUPPLIER }), "10:00", [
        button("CONFIRM_CONTACT", "interactive"),
        button("REJECT_CONTACT", "interactive"),
        button("OTHER_CONTACT", "interactive"),
      ]),
      tap("CONFIRM_CONTACT", "interactive", "10:00"),
      firmText("agent", AGENT_EXAMPLES.deferred.es, AGENT_EXAMPLES.deferred.en, "10:00"),
    ],
  },
  noAction: {
    id: "noAction",
    day: "16/10",
    // Only the correction notice: the corrected packing list arrives after the ETA change (step 6),
    // so the importer is never told the file is complete and then given a new deadline for it.
    messages: [templateMessage("legajo_observacion_proveedor", [STORY.operationNumber, CORRECTION_TARGET], "09:00", [STORY.operationNumber, CORRECTION_TARGET_EN])],
  },
  question: {
    id: "question",
    day: "16/10",
    messages: [
      importerText("¿Qué posición arancelaria va?", "Which tariff classification applies?", "10:24"),
      firmText("fixed", importerEsAR.guardrailRefusal, importerGloss.guardrailRefusal, "10:24"),
      templateMessage("legajo_escalado", [STORY.operationNumber, STORY.firmName], "10:25"),
    ],
  },
  eta: {
    id: "eta",
    day: "16/10",
    messages: [templateMessage("legajo_nuevo_plazo", [STORY.operationNumber, STORY.newEtaText, STORY.newDeadlineText], "10:00")],
  },
  approval: {
    id: "approval",
    day: "16/10",
    messages: [
      firmText("agent", AGENT_EXAMPLES.arrived.es, AGENT_EXAMPLES.arrived.en, "10:50"),
      templateMessage("legajo_aprobado", [STORY.operationNumber], "11:00"),
      templateMessage("despacho_estado", [STORY.operationNumber, NARANJA.statusText, NARANJA.explanation], "11:10", [STORY.operationNumber, NARANJA_EN.statusText, NARANJA_EN.explanation]),
      templateMessage("despacho_estado", [STORY.operationNumber, LIBERADO.statusText, LIBERADO.explanation], "11:20", [STORY.operationNumber, LIBERADO_EN.statusText, LIBERADO_EN.explanation]),
    ],
  },
};

export function conversation(id: ConversationId): ConversationView {
  return CONVERSATIONS[id];
}

/** The hero's script: the first request and the delegation to the supplier, in that order (§4.4). */
export function heroMessages(): readonly WaMessageView[] {
  return [...CONVERSATIONS.request.messages, ...CONVERSATIONS.delegate.messages];
}

/** At rest the hero's phone opens at the firm's question (the fixed text), not cut at the newest message. */
export const HERO_ANCHOR = Math.max(
  0,
  heroMessages().findIndex((message) => message.source === "fixed"),
);

/**
 * The escalation email the broker receives for the tariff question of step 7, as `firmEsAR` writes it
 * for a denied topic (`OUT_OF_CHECKLIST`): its subject and the lines that name the operation and the
 * reason. The rest of the body depends on the dossier at that moment, so the landing does not show it.
 */
const escalation = firmEsAR.escalationEmail({
  operationNumber: STORY.operationNumber,
  importerName: STORY.importerName,
  supplierName: STORY.supplierName,
  reason: "OUT_OF_CHECKLIST",
  summary: "",
  dossierStatus: "OPEN",
  etaText: STORY.newEtaText,
  documents: [],
  attempts: [],
  consoleUrl: `https://${STAGE_DOMAIN}/app/operations`,
});
export const ESCALATION_EMAIL = { subject: escalation.subject, lines: escalation.body.split("\n").slice(0, 2) } as const;

// ---- Email with the supplier ------------------------------------------------------------------

export interface EmailView {
  readonly id: "request" | "reply" | "correction" | "corrected";
  readonly direction: "out" | "in";
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  /** Simulated time in Argentina and in the supplier's zone (Asia/Shanghai). */
  readonly at: { readonly ar: string; readonly supplier: string };
  readonly body: string;
  readonly attachments: readonly string[];
  /** `agent`: an example of the body the model writes; `simulator`: the real text of the simulated supplier. */
  readonly source: "agent" | "simulator";
}

const FIRM_SENDER = `${supplierEmailEn.displayName(STORY.firmName)} <${STORY.threadAddress}>`;
const SUPPLIER_SENDER = `${STORY.supplierName} <${STORY.supplierAddress}>`;
/** Documents of the request, and of the correction, in the order the subjects list them. */
export const REQUESTED: readonly DocType[] = ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"];
export const CORRECTED: readonly DocType[] = ["PACKING_LIST"];
const subjectParams = { operationNumber: STORY.operationNumber, invoiceNumber: STORY.invoiceNumber } as const;
export const REQUEST_SUBJECT = supplierEmailEn.subject("DOCS_REQUEST", { ...subjectParams, docTypes: REQUESTED });
export const CORRECTION_SUBJECT = supplierEmailEn.subject("CORRECTION_REQUEST", {
  ...subjectParams,
  docTypes: CORRECTED,
  observation: { code: "GROSS_WEIGHT_MISMATCH", docType: "PACKING_LIST" },
});

const EmailText = z.object({ subject: z.string().min(1), body: z.string().min(1) }).strict();
/** Shape of supplier-replies.json. */
export const SupplierReplies = z.object({ generatedBy: z.literal("scripts/landing/supplier-replies.ts"), reply: EmailText, corrected: EmailText }).strict();
export type SupplierReplies = z.infer<typeof SupplierReplies>;
const { reply, corrected } = SupplierReplies.parse(supplierReplies);

/** The thread of scene 3, in the order it happens. */
export const SUPPLIER_THREAD: readonly EmailView[] = [
  {
    id: "request",
    direction: "out",
    from: FIRM_SENDER,
    to: STORY.supplierAddress,
    subject: REQUEST_SUBJECT,
    at: { ar: "15/10 22:00", supplier: "16/10 09:00" },
    body: `Hello,\n\nFor invoice ${STORY.invoiceNumber} (FOB Qingdao), vessel ${STORY.vessel}, we still need the packing list and the certificate of origin. Both must match the commercial invoice. Please send them by 18/10 17:00 Qingdao time.\n\nThank you,\n${STORY.firmName}`,
    attachments: [],
    source: "agent",
  },
  { id: "reply", direction: "in", from: SUPPLIER_SENDER, to: STORY.threadAddress, subject: reply.subject, at: { ar: "15/10 22:10", supplier: "16/10 09:10" }, body: reply.body, attachments: ["packing-list.pdf", "certificate-of-origin.pdf"], source: "simulator" },
  {
    id: "correction",
    direction: "out",
    from: FIRM_SENDER,
    to: STORY.supplierAddress,
    subject: CORRECTION_SUBJECT,
    at: { ar: "15/10 22:10", supplier: "16/10 09:10" },
    body: `Hello,\n\nThe packing list shows a gross weight of 12,480 kg, while commercial invoice ${STORY.invoiceNumber} says 12,840 kg. Please send a corrected packing list by 18/10 17:00 Qingdao time.\n\nThank you,\n${STORY.firmName}`,
    attachments: [],
    source: "agent",
  },
  { id: "corrected", direction: "in", from: SUPPLIER_SENDER, to: STORY.threadAddress, subject: corrected.subject, at: { ar: "15/10 22:20", supplier: "16/10 09:20" }, body: corrected.body, attachments: ["packing-list-v2.pdf"], source: "simulator" },
];
