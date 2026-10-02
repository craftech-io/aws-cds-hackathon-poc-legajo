// Fixed English gloss of every Spanish template and fixed text, shown with "EN" in the phone
// simulator, the demo mailbox and the guided tour so a guest who reads no Spanish follows the story
// (docs/design-brief.md §10). A gloss is never sent to anybody. Each one implements the same type as
// its Spanish source, so a text without a gloss does not compile; parameters stay as the importer saw
// them.
import type { WaButtonAction, WhatsAppTemplateName } from "@legajo/shared";
import { BUTTON_LABELS, LIST_ROW_DESCRIPTION_MAX_CHARS } from "./buttons";
import { OPT_OUT_KEYWORDS, type ConsentTextParams, type ConsentTextVersion } from "./consent";
import type { DispatchGlossaryEntry, DispatchGlossaryKey } from "./dispatch-glossary";
import { labelsEn } from "./en";
import { buildFirmTexts } from "./firm-mail";
import { PRODUCT_NAME, fillPlaceholders, fitChars } from "./helpers";
import type { FirmTexts, ImporterTexts } from "./types";

export const importerGloss: ImporterTexts = {
  guardrailRefusal: "We cannot handle that in this chat. We already told the firm and a person will write to you here.",
  unknownSender:
    "Hello. This number is not registered with any firm that uses this channel, so we cannot continue the conversation here. If you work with a firm, ask them to register your phone.",
  rateLimited: "We received many messages in a row. Please wait a while and write to us again.",
  rejectedMedia: "We can only receive documents as PDF. Send it as a PDF here or upload it with the upload link.",
  mediaTooLarge: "The PDF is larger than 10 MB and we could not receive it. Send a lighter version or upload it with the upload link.",
  optOutConfirmation: "Done, we will not send you any more WhatsApp notices. The firm will follow up on your operations by other means.",
  questionPrompt: "What is your question? Write it here and we will answer.",
  contactConfirmation: ({ maskedEmail }) => `Shall we write to your supplier at ${maskedEmail}? Confirm with a button or give us another contact.`,
  operationChoice: {
    body: "You have more than one open operation with the firm. Which one is your message about?",
    rowDescription: ({ supplierName, etaText }) => fitChars(`${supplierName} · estimated arrival ${etaText}`, LIST_ROW_DESCRIPTION_MAX_CHARS),
  },
};

/** Same placeholders as the Spanish body of templates.ts. */
export const TEMPLATE_GLOSS: Readonly<Record<WhatsAppTemplateName, string>> = {
  legajo_docs_pendientes: "Hi, we are writing from {{1}}. Operation {{2}}, vessel {{3}}, estimated arrival {{4}}. Missing: {{5}}. How do we proceed?",
  legajo_recordatorio: "Operation {{1}}: {{2}} are still missing. The deadline is {{3}}. You can upload them or let us know.",
  legajo_observacion_proveedor: "Operation {{1}}: the supplier has to correct {{2}}. We already asked them; you do not have to do anything for now.",
  legajo_contacto_proveedor: "Operation {{1}}: we could not deliver the email to your supplier ({{2}}). Can you give us another contact?",
  legajo_nuevo_plazo: "Operation {{1}}: the estimated arrival changed to {{2}}. The new deadline for the documents is {{3}}.",
  legajo_escalado: "Operation {{1}}: a person from {{2}} will continue with you in this chat.",
  legajo_aprobado: "Operation {{1}}: the firm approved the dossier. We will tell you about the customs dispatch here.",
  despacho_estado: "Operation {{1}}: {{2}}. {{3}} If you have any questions, ask the firm.",
};

export const BUTTON_GLOSS: Readonly<Record<WaButtonAction, string>> = {
  UPLOAD: "Upload documents",
  SUPPLIER_SENDS: "The supplier sends them",
  QUESTION: "I have a question",
  OPT_OUT: "Stop notices",
  CONFIRM_CONTACT: "Yes, write to them",
  REJECT_CONTACT: "No",
  OTHER_CONTACT: "Here is another contact",
  TALK_TO_FIRM: "Talk to the firm",
  CHOOSE_OPERATION: "Choose operation",
};

export const CONSENT_GLOSS: Readonly<Record<ConsentTextVersion, (params: ConsentTextParams) => string>> = {
  v1: ({ firmName }) =>
    `I agree that ${firmName} writes to me on WhatsApp, via ${PRODUCT_NAME}, about the documents of my import operations: missing documents, corrections, deadlines and dispatch status. ` +
    "The firm will never ask me in this chat for bank details, passwords or identity documents. " +
    `I can stop these notices at any time by replying ${OPT_OUT_KEYWORDS[0]} or tapping "${BUTTON_LABELS.OPT_OUT.template}" (${BUTTON_GLOSS.OPT_OUT}).`,
};

export const DISPATCH_GLOSS: Readonly<Record<DispatchGlossaryKey, DispatchGlossaryEntry>> = {
  OFICIALIZADO: {
    statusText: "the customs declaration was made official",
    explanation: "It means customs registered the declaration and the procedure started.",
  },
  "CANAL_ASIGNADO#VERDE": {
    statusText: "customs assigned the green channel",
    explanation: "It means customs will not review the documents or the goods before releasing them.",
  },
  "CANAL_ASIGNADO#NARANJA": {
    statusText: "customs assigned the orange channel",
    explanation: "It means customs will review the documents before releasing the goods.",
  },
  "CANAL_ASIGNADO#ROJO": {
    statusText: "customs assigned the red channel",
    explanation: "It means customs will review the documents and the goods before releasing them.",
  },
  LIBERADO: {
    statusText: "the goods were released",
    explanation: "It means customs finished the procedure for this operation.",
  },
};

export const firmGloss: FirmTexts = buildFirmTexts(
  {
    escalationSubject: ({ operationNumber, reasonLabel }) => `[Op ${operationNumber}] Escalation: ${reasonLabel}`,
    operationLine: ({ operationNumber, importerName, supplierName }) => `Operation ${operationNumber} · ${importerName} · ${supplierName}`,
    reasonLine: (reasonLabel) => `Reason: ${reasonLabel}.`,
    summaryLine: (summary) => `Summary: ${summary}`,
    dossierLine: ({ statusLabel, etaText }) => `Dossier ${statusLabel} · estimated arrival ${etaText}`,
    responsible: "responsible",
    attemptsHeading: "What was tried:",
    noAttempts: "- No messages yet.",
    to: "to the",
    riskLine: (riskText) => `Estimated risk: ${riskText}`,
    escalationFooter: `This notice is sent by ${PRODUCT_NAME} and is not answered by email: follow the operation in the console.`,
    readySubject: (operationNumber) => `[Op ${operationNumber}] Dossier ready for review`,
    readyLead: "The three documents are valid and the dossier is ready for review.",
    readySummaryHeading: "How each observation was resolved:",
    readyFooter: "Approval belongs to the customs broker: review documents, readings and observations in the console and approve there.",
    guardrailSummary: {
      promptAttack: "possible injection",
      cardData: "card data",
    },
  },
  labelsEn,
);

/** English gloss of a rendered template, with the same parameters the importer saw. */
export function glossTemplate(name: WhatsAppTemplateName, params: readonly string[]): string {
  return fillPlaceholders(TEMPLATE_GLOSS[name], params);
}
