// What the importer reads on the upload page `/u/<token>` (docs/design-brief.md §7), in Rioplatense
// Spanish (voseo). Document names come from copy/es-AR.ts (one source per word); only what exists
// nowhere else lives here. The page shows the operation number and the documents the link asks for,
// never a name or a contact of anybody: an error page shows no data at all.
import type { DocType } from "@legajo/shared";
import { MAX_DOCUMENT_BYTES } from "../domain/documents";
import { labelsEsAR, missingDocumentsEsAR } from "../copy/es-AR";
import { PRODUCT_NAME, capitalize } from "../copy/helpers";

const MAX_MB = MAX_DOCUMENT_BYTES / (1024 * 1024);

/** Error pages of an unusable link; none of them names the operation or its documents. */
export type ErrorPageKind = "notFound" | "expired" | "used" | "unavailable";

export interface ErrorPageText {
  readonly title: string;
  readonly body: string;
}

/** States and messages the page script shows next to a document, and after "Listo". */
export interface UploadScriptTexts {
  readonly uploading: string;
  readonly uploaded: string;
  readonly notPdf: string;
  readonly tooLarge: string;
  readonly empty: string;
  readonly failed: string;
  readonly limit: string;
  readonly linkGone: string;
  readonly doneFailed: string;
}

export const uploadPageEsAR = {
  lang: "es-AR",
  title: `Subir documentos · ${PRODUCT_NAME}`,
  heading: (operationNumber: string): string => `Operación ${operationNumber}`,
  intro: `Subí en PDF los documentos que faltan. Cada archivo puede pesar hasta ${MAX_MB} MB.`,
  listHeading: "Documentos que faltan",
  chooseFile: "Elegir PDF",
  doneButton: "Listo",
  doneHint: "Cuando termines de subir, tocá «Listo» y el estudio sigue con tu legajo.",
  confirmationHeading: "¡Gracias!",
  confirmationBody: "Recibimos los archivos. El estudio los revisa y te avisa por WhatsApp si hace falta algo más.",
  footer: `${PRODUCT_NAME} · Powered by Craftech`,
  script: {
    uploading: "Subiendo…",
    uploaded: "Subido",
    notPdf: "Ese archivo no es un PDF. Elegí el documento en PDF.",
    tooLarge: `El PDF pesa más de ${MAX_MB} MB. Elegí una versión más liviana.`,
    empty: "El archivo está vacío. Elegí otro.",
    failed: "No pudimos subir el archivo. Probá de nuevo.",
    limit: "Llegaste al máximo de archivos de este link. Avisale al estudio por WhatsApp.",
    linkGone: "Este link ya no se puede usar. Pedile uno nuevo al estudio por WhatsApp.",
    doneFailed: "No pudimos avisarle al estudio. Probá tocar «Listo» de nuevo.",
  } satisfies UploadScriptTexts,
  errors: {
    notFound: {
      title: "Link no válido",
      body: "Este link no existe o ya no se puede usar. Si tenés que subir documentos, pedile un link nuevo al estudio por WhatsApp.",
    },
    expired: {
      title: "Link vencido",
      body: "Este link venció. Si todavía tenés que subir documentos, pedile uno nuevo al estudio por WhatsApp.",
    },
    used: {
      title: "Link usado",
      body: "Ya recibimos todos los documentos de este link. Si tenés que mandar otro, pedile un link nuevo al estudio por WhatsApp.",
    },
    unavailable: {
      title: "No pudimos abrir la página",
      body: "Probá de nuevo en unos minutos.",
    },
  } satisfies Readonly<Record<ErrorPageKind, ErrorPageText>>,
} as const;

/** "Certificado de origen": the document as a line of the page opens it. */
export function documentLabel(docType: DocType): string {
  return capitalize(labelsEsAR.docType[docType]);
}

/** Closing line after "Listo": what the link still asks for, or that nothing is missing. */
export function confirmationPending(pending: readonly DocType[]): string {
  if (pending.length === 0) return "Ya tenemos todo lo que pedía este link.";
  const documents = missingDocumentsEsAR(pending);
  return pending.length === 1
    ? `Todavía falta: ${documents}. Podés volver a este link para subirlo.`
    : `Todavía faltan: ${documents}. Podés volver a este link para subirlos.`;
}
