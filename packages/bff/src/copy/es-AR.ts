// What the importer reads, in Rioplatense Spanish (voseo), plus the Spanish words for the enums a
// person sees (CONTEXT.md). Sent as WhatsApp by the system, never written by the model: the model's
// own replies go through G2 and the deterministic check of the outbound pipeline instead. The
// English gloss of every text lives in en-gloss.ts with the same keys.
import type { DocType } from "@legajo/shared";
import { LIST_ROW_DESCRIPTION_MAX_CHARS } from "./buttons";
import { fitChars, joinList } from "./helpers";
import type { ImporterTexts, Labels } from "./types";

export const labelsEsAR: Labels = {
  docType: {
    COMMERCIAL_INVOICE: "factura comercial",
    PACKING_LIST: "packing list",
    CERTIFICATE_OF_ORIGIN: "certificado de origen",
  },
  docStatus: {
    MISSING: "faltante",
    RECEIVED: "recibido",
    WITH_OBSERVATION: "con observación",
    VALID: "válido",
  },
  dossierStatus: {
    OPEN: "abierto",
    READY_FOR_REVIEW: "listo para revisión",
    APPROVED: "aprobado",
    REOPENED: "reabierto",
  },
  party: {
    IMPORTER: "importador",
    SUPPLIER: "proveedor",
    BROKER: "estudio",
  },
  channel: {
    WHATSAPP: "WhatsApp",
    EMAIL: "email",
  },
  messageKind: {
    DOCS_REQUEST: "pedido de documentos",
    REMINDER: "recordatorio",
    CORRECTION_REQUEST: "pedido de corrección",
    NO_ACTION_NEEDED: "aviso sin acción pendiente",
    CONTACT_REQUEST: "pedido de otro contacto",
    CONTACT_CONFIRMATION: "confirmación de contacto",
    UPLOAD_LINK: "link de carga",
    ETA_CHANGE: "cambio de arribo estimado",
    ESCALATION_NOTICE: "aviso de traspaso al estudio",
    ESCALATION: "escalamiento",
    APPROVAL_NOTICE: "aviso de aprobación",
    DISPATCH_STATUS: "estado del despacho",
    REPLY: "respuesta",
    BROKER_MESSAGE: "mensaje del estudio",
    OPT_OUT_CONFIRMATION: "confirmación de baja",
    OPERATION_CHOICE: "elección de operación",
  },
  escalationReason: {
    MISSING_AT_ETA_48H: "faltan documentos a 48 h del arribo",
    OBSERVATION_ATTEMPTS: "una corrección volvió con la misma observación",
    OUT_OF_CHECKLIST: "consulta fuera del checklist",
    IMPORTER_ASKED: "el importador pidió hablar con una persona",
    UNRECOGNIZED_DOCUMENT: "documento que el lector no reconoce",
    NO_VALID_CONTACT: "proveedor sin contacto válido",
    UNTRUSTED_SENDER: "email de un remitente no confiable",
    OPTED_OUT: "el importador pidió no recibir avisos",
    READER_UNAVAILABLE: "lector documental no disponible",
    OTHER: "otro motivo",
  },
};

/** "del packing list", "de la factura comercial": the document after a field that has to be fixed. */
export const docTypeOfEsAR: Readonly<Record<DocType, string>> = {
  COMMERCIAL_INVOICE: `de la ${labelsEsAR.docType.COMMERCIAL_INVOICE}`,
  PACKING_LIST: `del ${labelsEsAR.docType.PACKING_LIST}`,
  CERTIFICATE_OF_ORIGIN: `del ${labelsEsAR.docType.CERTIFICATE_OF_ORIGIN}`,
};

/** "certificado de origen y packing list": the missing documents of a template parameter. */
export function missingDocumentsEsAR(docTypes: readonly DocType[]): string {
  return joinList(
    docTypes.map((docType) => labelsEsAR.docType[docType]),
    "y",
  );
}

export const importerEsAR: ImporterTexts = {
  guardrailRefusal: "Eso no lo podemos resolver por este chat. Ya le avisamos al estudio y una persona te va a escribir por acá.",
  unknownSender:
    "Hola. Este número no está registrado en ningún estudio que use este canal, así que no podemos seguir la conversación por acá. Si trabajás con un estudio, pedile que registre tu teléfono.",
  rateLimited: "Recibimos muchos mensajes seguidos. Esperá un rato y volvé a escribirnos, por favor.",
  rejectedMedia: "Solo podemos recibir documentos en PDF. Mandalo en PDF por acá o subilo con el link de carga.",
  mediaTooLarge: "El PDF pesa más de 10 MB y no lo pudimos recibir. Mandá una versión más liviana o subilo con el link de carga.",
  optOutConfirmation:
    "Listo, no te vamos a mandar más avisos por WhatsApp. El estudio va a seguir tus operaciones por otro medio.",
  questionPrompt: "¿Cuál es tu duda? Escribila por acá y te respondemos.",
  contactConfirmation: ({ maskedEmail }) =>
    `¿Le escribimos a tu proveedor a ${maskedEmail}? Confirmá con un botón o pasanos otro contacto.`,
  operationChoice: {
    body: "Tenés más de una operación abierta con el estudio. ¿Sobre cuál es tu mensaje?",
    rowDescription: ({ supplierName, etaText }) => fitChars(`${supplierName} · arribo estimado ${etaText}`, LIST_ROW_DESCRIPTION_MAX_CHARS),
  },
};
