// Emails to the firm's mailbox from "Legajo listo" <avisos@…> (docs/architecture-integrations.md §1):
// escalations (docs/design-brief.md §5.8) and "listo para revisión". Spanish, because the reader is
// the customs broker; the body always says the firm answers from the console, never by replying.
import { labelsEsAR } from "./es-AR";
import { buildFirmTexts, type FirmWords } from "./firm-mail";
import { PRODUCT_NAME } from "./helpers";

const firmWordsEsAR: FirmWords = {
  escalationSubject: ({ operationNumber, reasonLabel }) => `[Op ${operationNumber}] Escalamiento: ${reasonLabel}`,
  operationLine: ({ operationNumber, importerName, supplierName }) => `Operación ${operationNumber} · ${importerName} · ${supplierName}`,
  reasonLine: (reasonLabel) => `Motivo: ${reasonLabel}.`,
  summaryLine: (summary) => `Resumen: ${summary}`,
  dossierLine: ({ statusLabel, etaText }) => `Legajo ${statusLabel} · arribo estimado ${etaText}`,
  responsible: "responsable",
  attemptsHeading: "Lo intentado:",
  noAttempts: "- Todavía no hubo mensajes.",
  to: "al",
  riskLine: (riskText) => `Riesgo estimado: ${riskText}`,
  escalationFooter: `Este aviso lo envía ${PRODUCT_NAME} y no se responde por email: seguí la operación desde la consola.`,
  readySubject: (operationNumber) => `[Op ${operationNumber}] Legajo listo para revisión`,
  readyLead: "Los tres documentos quedaron válidos y el legajo está listo para revisión.",
  readySummaryHeading: "Cómo se resolvió cada observación:",
  readyFooter: "La aprobación es del despachante: revisá documentos, lecturas y observaciones en la consola y aprobá desde ahí.",
  completedByFirm: "El estudio resolvió desde la consola lo que quedaba pendiente.",
  guardrailSummary: {
    promptAttack: "posible inyección",
    cardData: "datos de tarjeta",
  },
};

export const firmEsAR = buildFirmTexts(firmWordsEsAR, labelsEsAR);
