// Texts of the bitácora (`/app/audit`, docs/design-brief.md §6, FL-086) and the words the firm reads
// for what the audit log stores as codes: decisions, actions, turn triggers and actors. An action the
// map does not know yet reads as plain lowercase words, never as its raw code.
import type { AuditDecision, TurnTrigger } from "@legajo/shared";

export const auditCopy = {
  counters: {
    title: "Resumen de la política",
    violations: "Violaciones de política",
    violationsHint: "Tiene que ser 0: un envío sin decisión permitida o que la política, reevaluada después, habría denegado.",
    denied: "Decisiones denegadas",
    deferred: "Decisiones diferidas",
    evidenceHint: "La política frenando al agente es la evidencia junto al 0.",
  },
  byRule: {
    title: "Decisiones denegadas y diferidas por regla",
    description: "Cuántas veces cada regla frenó o difirió un envío en este mundo.",
    empty: "Ninguna regla denegó ni difirió un envío en este mundo todavía.",
    rule: "Regla",
    denied: "Denegadas",
    deferred: "Diferidas",
  },
  list: {
    title: "Decisiones",
    description: "Cada decisión con la regla aplicada, el evento que la disparó y quién la tomó, de la más nueva a la más vieja.",
    empty: "No hay decisiones con estos filtros.",
    at: "Hora",
    decision: "Decisión",
    action: "Qué",
    rules: "Reglas",
    trigger: "Disparador",
    actor: "Quién",
    operation: "Operación",
    noRules: "Sin reglas",
  },
  filters: {
    label: "Filtros de la bitácora",
    operation: "Operación",
    allOperations: "Todas las operaciones",
    decision: "Decisión",
    rule: "Regla",
    allRules: "Todas las reglas",
    actor: "Quién",
    allActors: "Todos",
  },
} as const;

export const DECISION_LABELS: Readonly<Record<AuditDecision, string>> = {
  ALLOW: "Permitido",
  DENY: "Denegado",
  DEFER: "Diferido",
  ACTION: "Acción",
  VIOLATION: "Violación",
};

/** Plural labels of the decision filter. */
export const DECISION_FILTER_LABELS: Readonly<Record<AuditDecision | "ALL", string>> = {
  ALL: "Todas",
  ALLOW: "Permitidas",
  DENY: "Denegadas",
  DEFER: "Diferidas",
  ACTION: "Acciones",
  VIOLATION: "Violaciones",
};

export const TRIGGER_LABELS: Readonly<Record<TurnTrigger, string>> = {
  IMPORTER_MESSAGE: "Mensaje del importador",
  SUPPLIER_EMAIL: "Email del proveedor",
  DOCUMENT_READ: "Documento leído",
  MILESTONE: "Hito",
  ETA_CHANGED: "Cambio de ETA",
  EMAIL_BOUNCED: "Email rebotado",
  CONTACT_CONFIRMED: "Contacto confirmado",
  UPLOAD_COMPLETED: "Carga por link",
  BROKER_RELEASED: "Devuelto al agente",
  FOLLOWUP_DUE: "Seguimiento agendado",
};

/** Who acted, grouped the way the filter offers it (`BROKER:<id>` is "Estudio"). */
export type ActorKind = "AGENT" | "SYSTEM" | "IMPORTER" | "SUPPLIER" | "FIRM" | "SEED" | "QA";

export const ACTOR_LABELS: Readonly<Record<ActorKind, string>> = {
  AGENT: "Agente",
  SYSTEM: "Sistema (código determinista)",
  IMPORTER: "Importador",
  SUPPLIER: "Proveedor",
  FIRM: "Persona del estudio",
  SEED: "Datos sembrados",
  QA: "Ejecutor de escenarios",
};

export const ACTION_LABELS: Readonly<Record<string, string>> = {
  SEND_WHATSAPP: "WhatsApp al importador",
  SEND_EMAIL: "Email al proveedor",
  CONSENT_GRANTED: "Opt-in registrado",
  CONSENT_REVOKED: "Opt-in revocado",
  CONTACT_CONFIRMED: "Contacto confirmado",
  OPERATION_CREATED: "Operación creada",
  DOCUMENT_READ: "Documento leído",
  TIMER_FIRED: "Temporizador disparado",
  MILESTONE_FIRED: "Hito disparado",
  SKIPPED: "Sin acción (ya no hacía falta)",
  ETA_RESCHEDULED: "Hitos reprogramados por la ETA",
  GUARDRAIL_BLOCK: "Bloqueo del guardrail",
  GUARDRAIL_MASK: "Datos enmascarados por el guardrail",
  APPROVED: "Legajo aprobado",
  REOPENED: "Legajo reabierto",
  WAIVED: "Observación dispensada",
  TAKEOVER: "Conversación tomada",
  RELEASE: "Conversación devuelta al agente",
  CLOCK_ADVANCED: "Reloj avanzado",
  CLOCK_FORCED: "Reloj avanzado con el mundo ocupado",
  WORLD_CREATED: "Mundo creado",
  WORLD_RESET: "Demo reiniciada",
  SIM_REPLY: "Respuesta del proveedor simulado",
  SEED_LOADED: "Datos cargados",
  EVENT_DEAD_LETTERED: "Evento con error de proceso",
  TURN_CAP: "Tope de turnos",
  AGENT_FALLBACK: "Envío de respaldo del primer pedido",
  AGENT_REFUSAL: "El agente derivó al estudio",
  CROSS_FIRM: "Dato de otro estudio",
  INPUT_TOO_LARGE: "Pedido demasiado grande",
  ROLE_NOT_ALLOWED: "Rol sin permiso",
  RATE_LIMIT: "Límite de mensajes por hora",
  UNKNOWN_SENDER: "Remitente no registrado",
  UNTRUSTED_SENDER: "Remitente no confiable",
  SIM_UNTRUSTED: "Correo ajeno al simulador",
};
