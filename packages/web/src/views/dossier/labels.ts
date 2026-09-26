// What the firm reads for each code of an operation, its dossier and its timeline, in rioplatense
// Spanish (CONTEXT.md vocabulary). Shared by the three views of the files group (operations, dossier,
// escalations); a code never reaches the screen raw: an unknown one falls back to a generic label.
import {
  type AuditDecision,
  type Channel,
  type ConversationControl,
  type CustomsChannel,
  type DispatchStatus,
  type DocStatus,
  type DocType,
  type DocumentSourceChannel,
  type DossierStatus,
  type EscalationReason,
  type MessageKind,
  MilestoneName,
  type ObservationCode,
  type ObservationSeverity,
  type ObservationStatus,
  type OperationEventType,
  type Party,
  type ReadingStatus,
  type TimerKind,
  TurnTrigger,
} from "@legajo/shared";
import type { BadgeTone } from "../../components/Badge";
import type { Risk } from "./risk";

export const DOC_TYPE_ORDER: readonly DocType[] = ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"];

export const docTypeLabel: Readonly<Record<DocType, string>> = {
  COMMERCIAL_INVOICE: "Factura comercial",
  PACKING_LIST: "Packing list",
  CERTIFICATE_OF_ORIGIN: "Certificado de origen",
};

export const docStatusLabel: Readonly<Record<DocStatus, string>> = {
  MISSING: "Faltante",
  RECEIVED: "Recibido",
  WITH_OBSERVATION: "Con observación",
  VALID: "Válido",
};

export const docStatusTone: Readonly<Record<DocStatus, BadgeTone>> = {
  MISSING: "neutral",
  RECEIVED: "info",
  WITH_OBSERVATION: "warning",
  VALID: "success",
};

export const dossierStatusLabel: Readonly<Record<DossierStatus, string>> = {
  OPEN: "Abierto",
  READY_FOR_REVIEW: "Listo para revisión",
  APPROVED: "Aprobado",
  REOPENED: "Reabierto",
};

export const dossierStatusTone: Readonly<Record<DossierStatus, BadgeTone>> = {
  OPEN: "info",
  READY_FOR_REVIEW: "brand",
  APPROVED: "success",
  REOPENED: "warning",
};

export const riskLabel: Readonly<Record<Risk, string>> = {
  AT_RISK: "En riesgo",
  ON_TRACK: "En plazo",
  COMPLETE: "Completo",
};

export const riskTone: Readonly<Record<Risk, BadgeTone>> = {
  AT_RISK: "danger",
  ON_TRACK: "info",
  COMPLETE: "success",
};

export const partyLabel: Readonly<Record<Party, string>> = {
  IMPORTER: "Importador",
  SUPPLIER: "Proveedor",
  BROKER: "Estudio",
};

export const controlLabel: Readonly<Record<ConversationControl, string>> = {
  AGENT: "La lleva el agente",
  BROKER: "La tomó el estudio",
};

export const escalationReasonLabel: Readonly<Record<EscalationReason, string>> = {
  MISSING_AT_ETA_48H: "Faltan documentos a 48 h del arribo",
  OBSERVATION_ATTEMPTS: "Observación sin corregir tras dos intentos",
  OUT_OF_CHECKLIST: "Pregunta fuera del checklist",
  IMPORTER_ASKED: "El importador pidió hablar con una persona",
  UNRECOGNIZED_DOCUMENT: "Documento no reconocido por el lector",
  NO_VALID_CONTACT: "Proveedor sin contacto válido",
  UNTRUSTED_SENDER: "Remitente no verificado",
  OPTED_OUT: "El importador pidió no recibir avisos",
  READER_UNAVAILABLE: "El lector documental no respondió",
  OTHER: "Otro motivo",
};

export const observationStatusLabel: Readonly<Record<ObservationStatus, string>> = {
  OPEN: "Abierta",
  CORRECTION_REQUESTED: "Corrección pedida",
  RESOLVED: "Resuelta",
  ESCALATED: "Escalada al estudio",
  WAIVED_BY_BROKER: "Dispensada por el estudio",
};

export const observationStatusTone: Readonly<Record<ObservationStatus, BadgeTone>> = {
  OPEN: "warning",
  CORRECTION_REQUESTED: "info",
  RESOLVED: "success",
  ESCALATED: "danger",
  WAIVED_BY_BROKER: "neutral",
};

/** What the reader found, as the console names it (the reader's code stays its own, ADR-0003). */
export const observationCodeLabel: Readonly<Record<ObservationCode, string>> = {
  GROSS_WEIGHT_MISMATCH: "Peso bruto distinto del de la factura",
  NET_WEIGHT_MISMATCH: "Peso neto distinto del de la factura",
  INVOICE_NUMBER_MISMATCH: "Número de factura distinto",
  INCOTERM_MISMATCH: "Incoterm distinto del de la operación",
  BUYER_DATA_MISMATCH: "Datos del comprador distintos del registro",
  ORIGIN_MISMATCH: "País de origen distinto del de la factura",
  PACKAGES_MISMATCH: "Cantidad de bultos distinta de la factura",
  MISSING_SIGNATURE: "Falta la firma",
  MISSING_STAMP: "Falta el sello",
  LOW_CONFIDENCE: "Lectura de baja confianza",
};

export const severityLabel: Readonly<Record<ObservationSeverity, string>> = {
  BLOCKING: "Bloqueante",
  WARNING: "Advertencia",
};

export const readingStatusLabel: Readonly<Record<ReadingStatus, string>> = {
  RECOGNIZED: "Reconocido por el lector",
  UNRECOGNIZED: "No reconocido por el lector",
  ERROR: "El lector devolvió un error",
};

export const versionStateLabel: Readonly<Record<string, string>> = {
  RECEIVED: "Recibida, esperando lectura",
  READ: "Leída",
  UNRECOGNIZED: "No reconocida: la clasifica el estudio",
  CLASSIFIED: "Clasificada por el estudio",
  DISCARDED: "Descartada por el estudio",
  READER_UNAVAILABLE: "El lector no respondió",
};

export const sourceChannelLabel: Readonly<Record<DocumentSourceChannel, string>> = {
  EMAIL: "por email",
  WHATSAPP: "por WhatsApp",
  UPLOAD_LINK: "por el link de carga",
  CONSOLE: "desde la consola",
};

export const channelLabel: Readonly<Record<Channel, string>> = {
  WHATSAPP: "WhatsApp",
  EMAIL: "Email",
  CONSOLE: "Consola",
};

export const messageKindLabel: Readonly<Record<MessageKind, string>> = {
  DOCS_REQUEST: "Pedido de documentos",
  REMINDER: "Recordatorio",
  CORRECTION_REQUEST: "Pedido de corrección",
  NO_ACTION_NEEDED: "Aviso: no tiene que hacer nada",
  CONTACT_REQUEST: "Pedido de otro contacto",
  CONTACT_CONFIRMATION: "Confirmación de contacto",
  UPLOAD_LINK: "Link de carga",
  ETA_CHANGE: "Nuevo plazo por cambio de ETA",
  ESCALATION_NOTICE: "Aviso de traspaso al estudio",
  ESCALATION: "Escalamiento al estudio",
  APPROVAL_NOTICE: "Aviso de aprobación",
  DISPATCH_STATUS: "Estado del despacho",
  REPLY: "Respuesta",
  BROKER_MESSAGE: "Mensaje del estudio",
  OPT_OUT_CONFIRMATION: "Confirmación de baja",
  OPERATION_CHOICE: "Elección de operación",
};

export const messageStatusLabel: Readonly<Record<string, string>> = {
  RECEIVED: "Recibido",
  QUEUED: "En cola",
  DEFERRED: "Diferido",
  SENT: "Enviado",
  DELIVERED: "Entregado",
  READ: "Leído",
  DELAYED: "Demorado",
  FAILED: "No se pudo enviar",
  BOUNCED: "Rebotó",
  COMPLAINED: "Marcado como no deseado",
  QUARANTINED: "En cuarentena",
  DISCARDED: "Descartado",
};

const timerKindLabel: Readonly<Record<TimerKind, string>> = {
  MILESTONE: "Hito",
  DEFERRED_SEND: "Envío diferido",
  FOLLOWUP_DUE: "Seguimiento agendado por el agente",
  SIM_REPLY: "Esperando respuesta del proveedor por SES",
  READER_RETRY: "Reintento del lector documental",
  CONTACT_CHECK: "Control de contacto después de un rebote",
  BOUNCE_RETRY: "Reenvío después de un rebote transitorio",
};

const milestoneLabel: Readonly<Record<MilestoneName, string>> = {
  DOCS_REQUEST: "Pedido inicial (ETA − 7 días)",
  FOLLOWUP: "Recordatorio (ETA − 5 días)",
  FOLLOWUP_FINAL: "Último recordatorio (ETA − 3 días)",
  ESCALATION: "Escalamiento si faltan documentos (ETA − 48 h)",
  ARRIVAL: "Arribo (ETA)",
};

/** A timer as the firm names it: a milestone by its own name, anything else by its kind. */
export function timerTitle(kind: TimerKind, timerId: string): string {
  const milestone = MilestoneName.safeParse(timerId);
  return kind === "MILESTONE" && milestone.success ? milestoneLabel[milestone.data] : timerKindLabel[kind];
}

export const dispatchLabel: Readonly<Record<DispatchStatus, string>> = {
  NONE: "Sin novedades de aduana",
  OFICIALIZADO: "Oficializado",
  CANAL_ASIGNADO: "Canal asignado",
  LIBERADO: "Liberado",
};

export const customsChannelLabel: Readonly<Record<CustomsChannel, string>> = {
  VERDE: "verde",
  NARANJA: "naranja",
  ROJO: "rojo",
};

export const decisionLabel: Readonly<Record<AuditDecision, string>> = {
  ALLOW: "Permitido",
  DENY: "Denegado",
  DEFER: "Diferido",
  ACTION: "Acción",
  VIOLATION: "Violación de política",
};

export const decisionTone: Readonly<Record<AuditDecision, BadgeTone>> = {
  ALLOW: "success",
  DENY: "danger",
  DEFER: "warning",
  ACTION: "neutral",
  VIOLATION: "danger",
};

/** Actions of the audit log an operation's timeline shows; any other reads as its decision label. */
export const auditActionLabel: Readonly<Record<string, string>> = {
  OPERATION_CREATED: "Operación creada desde la plataforma",
  MILESTONE_FIRED: "Hito disparado",
  MILESTONE_SKIPPED: "Hito omitido",
  TIMER_FIRED: "Temporizador disparado",
  DOCUMENT_READ: "Documento leído por el lector",
  ASSIGN_RESPONSIBLE: "Responsable asignado",
  WAIVED: "Observación dispensada",
  APPROVED: "Legajo aprobado",
  REOPENED: "Legajo reabierto",
  TAKEOVER: "El estudio tomó la conversación",
  RELEASE: "Conversación devuelta al agente",
  ETA_RESCHEDULED: "Hitos reprogramados por cambio de ETA",
  CONTACT_CONFIRMED: "Contacto del proveedor confirmado",
  CONSENT_GRANTED: "Opt-in de WhatsApp registrado",
  CONSENT_REVOKED: "Opt-in de WhatsApp revocado",
  ESCALATION_RESOLVED: "Escalamiento resuelto",
  TURN_SKIPPED_CONTROL_BROKER: "Sin turno del agente: la conversación la tiene el estudio",
  GUARDRAIL_BLOCK: "Mensaje bloqueado por el guardrail de entrada",
  GUARDRAIL_MASK: "Datos sensibles enmascarados por el guardrail",
  EVENT_DEAD_LETTERED: "Evento sin procesar (cola de errores)",
  SIM_REPLY: "Respuesta del simulador de proveedor",
  AGENT_FALLBACK: "Mensaje de respaldo del sistema",
  TURN_CAP: "Tope de turnos del estudio alcanzado",
  AUTO_REPLY_IGNORED: "Respuesta automática ignorada",
  SEND_WHATSAPP: "Envío por WhatsApp",
  SEND_EMAIL: "Envío por email",
  CLASSIFIED: "Documento clasificado por el estudio",
  DISCARDED: "Documento descartado por el estudio",
};

const FIXED_ACTORS: Readonly<Record<string, string>> = {
  AGENT: "Agente",
  SYSTEM: "Sistema",
  IMPORTER: "Importador",
  SUPPLIER: "Proveedor",
  SEED: "Historia de la demo",
  QA: "Pruebas",
};

/** Who did it, never the broker's id: `BROKER:<id>` reads as the firm. */
export function actorLabel(actor: string): string {
  if (actor.startsWith("BROKER:")) return partyLabel.BROKER;
  return FIXED_ACTORS[actor] ?? FIXED_ACTORS.SYSTEM ?? "";
}

/** Codes a timer may carry as its reason besides a rule id; any other code is not shown. */
export const timerReasonLabel: Readonly<Record<string, string>> = {
  READER_UNAVAILABLE: "el lector documental no respondió",
  DOSSIER_COMPLETE: "el legajo ya está completo",
};

const turnTriggerLabel: Readonly<Record<TurnTrigger, string>> = {
  IMPORTER_MESSAGE: "mensaje del importador",
  SUPPLIER_EMAIL: "email del proveedor",
  DOCUMENT_READ: "lectura de un documento",
  MILESTONE: "hito",
  ETA_CHANGED: "cambio de ETA",
  EMAIL_BOUNCED: "rebote de un email",
  CONTACT_CONFIRMED: "contacto confirmado",
  UPLOAD_COMPLETED: "carga completa por el link",
  BROKER_RELEASED: "el estudio devolvió la conversación",
  FOLLOWUP_DUE: "seguimiento agendado",
};

/** The trigger of a turn note (the timeline carries it as plain text). */
export function turnTriggerText(trigger: string): string {
  const parsed = TurnTrigger.safeParse(trigger);
  return parsed.success ? turnTriggerLabel[parsed.data] : "";
}

export const eventTypeLabel: Readonly<Record<OperationEventType, string>> = {
  INTAKE_DOCUMENT: "lectura de un documento",
  AGENT_TURN: "turno del agente",
  TIMER: "temporizador",
  ETA_CHANGED: "cambio de ETA",
  DISPATCH_STATUS: "estado del despacho",
  EMAIL_EVENT: "evento de email",
  OUTBOUND_SEND: "envío ordenado por el estudio",
  ESCALATE: "escalamiento",
  HEALTH_PROBE: "prueba de salud",
  POISON: "evento de prueba",
};
