// What the agent wrote in the seeded past (docs/seed-spec.md §3): the few free texts of the histories
// of op-4478 and op-4488 and their clones. They are data of the demo, not product copy: every fixed
// text (templates, buttons, the contact confirmation, subjects, labels) comes from
// packages/bff/src/copy/, and these only fill the parts the agent writes itself, with facts of the
// operation only (numbers, documents, the supplier's name, the deadline in the supplier's zone).
import type { DocType } from "@legajo/shared";
import { documentSentenceEn } from "@legajo/bff/copy/en";
import { labelsEsAR } from "@legajo/bff/copy/es-AR";
import { joinList } from "@legajo/bff/copy/helpers";

export interface SupplierRequestFacts {
  readonly firmName: string;
  readonly importerName: string;
  readonly operationNumber: string;
  readonly invoiceNumber: string;
  readonly incoterm: string;
  readonly vessel: string;
  readonly etaText: string;
  readonly deadlineText: string;
  readonly docTypes: readonly DocType[];
}

/** First request to the supplier (`send_email DOCS_REQUEST`, FL-012). */
export function supplierDocsRequest(facts: SupplierRequestFacts): string {
  return [
    "Hello,",
    "",
    `We are writing on behalf of ${facts.firmName}, the customs broker of ${facts.importerName}, about invoice ${facts.invoiceNumber} (${facts.incoterm}, vessel ${facts.vessel}, estimated arrival in Buenos Aires on ${facts.etaText}).`,
    `For operation ${facts.operationNumber} we still need the ${documentSentenceEn(facts.docTypes)}. Please reply to this email with them as PDF by ${facts.deadlineText} (your time).`,
    "The packing list has to match the commercial invoice in gross weight and number of packages.",
    "",
    "Thank you,",
    facts.firmName,
  ].join("\n");
}

/** Reminder of the `FOLLOWUP` milestone (FL-028). */
export function supplierReminder(facts: SupplierRequestFacts): string {
  return [
    "Hello,",
    "",
    `This is a reminder about invoice ${facts.invoiceNumber} (operation ${facts.operationNumber}): the ${documentSentenceEn(facts.docTypes)} are still missing.`,
    `The deadline is ${facts.deadlineText} (your time). Please reply to this email with them as PDF.`,
    "",
    "Thank you,",
    facts.firmName,
  ].join("\n");
}

/** "el packing list y el certificado de origen": documents with their article, as the agent writes them. */
function withArticles(docTypes: readonly DocType[]): string {
  return joinList(
    docTypes.map((docType) => `${docType === "COMMERCIAL_INVOICE" ? "la" : "el"} ${labelsEsAR.docType[docType]}`),
    "y",
  );
}

/** Reply to the importer once the contact was confirmed (FL-012 step 4). */
export function supplierAskedReply(supplierName: string, operationNumber: string, docTypes: readonly DocType[]): string {
  return `Listo, ya le escribimos a ${supplierName} para pedirle ${withArticles(docTypes)} de la operación ${operationNumber}. Te avisamos cuando lleguen.`;
}

/** Reply after the importer sent the three PDFs and the packing list came back with a difference. */
export function packagesDifferenceReply(operationNumber: string): string {
  return `Recibimos la factura comercial, el packing list y el certificado de origen de la operación ${operationNumber}. El packing list tiene una diferencia en la cantidad de bultos con la factura y la corrección la tiene que emitir el proveedor. El estudio te va a confirmar cómo seguimos.`;
}

/** Reply once the corrected packing list is valid and the dossier waits for the firm's review. */
export function readyForReviewReply(operationNumber: string): string {
  return `Recibimos el packing list corregido de la operación ${operationNumber}. Los tres documentos están en regla y el legajo quedó listo para la revisión del estudio.`;
}

/** What the importer wrote with each PDF of op-4488 (and its clones). */
export const IMPORTER_PDF_TEXTS: Readonly<Record<DocType, string>> = {
  COMMERCIAL_INVOICE: "Te mando la factura comercial.",
  PACKING_LIST: "Va el packing list.",
  CERTIFICATE_OF_ORIGIN: "Y el certificado de origen.",
};

export const IMPORTER_CORRECTED_TEXT = "Te reenvío el packing list corregido.";

export const ESCALATION_NO_AUTH_SUMMARY = "Sin autorización para escribirle al proveedor: la corrección del packing list la gestiona el estudio.";
export const ESCALATION_NO_AUTH_RESOLUTION = "El estudio pidió la corrección al proveedor por fuera de la plataforma.";
