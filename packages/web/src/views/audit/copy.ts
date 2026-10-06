// Texts of the bitácora (`/app/audit`, docs/design-brief.md §6, FL-086) and the words the firm reads
// for what the audit log stores as codes: decisions, actions, turn triggers and actors, in Spanish and
// English (copy/localized.ts: the English has exactly the Spanish shape and the console's language
// picks one at render time). An action the map does not know yet reads as plain lowercase words, never
// as its raw code.
import type { AuditDecision, TurnTrigger } from "@legajo/shared";
import { localized, type Widen } from "../../copy/localized";

const es = {
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

export type AuditCopy = Widen<typeof es>;

const en = {
  counters: {
    title: "Policy summary",
    violations: "Policy violations",
    violationsHint: "It must be 0: a send with no allowed decision, or one the policy, re-evaluated later, would have denied.",
    denied: "Denied decisions",
    deferred: "Deferred decisions",
    evidenceHint: "The policy stopping the agent is the evidence next to the 0.",
  },
  byRule: {
    title: "Denied and deferred decisions by rule",
    description: "How many times each rule stopped or deferred a send in this world.",
    empty: "No rule has denied or deferred a send in this world yet.",
    rule: "Rule",
    denied: "Denied",
    deferred: "Deferred",
  },
  list: {
    title: "Decisions",
    description: "Every decision with the rule applied, the event that triggered it and who made it, newest first.",
    empty: "No decisions match these filters.",
    at: "Time",
    decision: "Decision",
    action: "What",
    rules: "Rules",
    trigger: "Trigger",
    actor: "Who",
    operation: "Operation",
    noRules: "No rules",
  },
  filters: {
    label: "Audit log filters",
    operation: "Operation",
    allOperations: "All operations",
    decision: "Decision",
    rule: "Rule",
    allRules: "All rules",
    actor: "Who",
    allActors: "Everyone",
  },
} satisfies AuditCopy;

export const auditCopy: AuditCopy = localized({ es, en });

const decisionEs = {
  ALLOW: "Permitido",
  DENY: "Denegado",
  DEFER: "Diferido",
  ACTION: "Acción",
  VIOLATION: "Violación",
} satisfies Record<AuditDecision, string>;

export const DECISION_LABELS: Readonly<Record<AuditDecision, string>> = localized({
  es: decisionEs,
  en: {
    ALLOW: "Allowed",
    DENY: "Denied",
    DEFER: "Deferred",
    ACTION: "Action",
    VIOLATION: "Violation",
  } satisfies Widen<typeof decisionEs>,
});

const decisionFilterEs = {
  ALL: "Todas",
  ALLOW: "Permitidas",
  DENY: "Denegadas",
  DEFER: "Diferidas",
  ACTION: "Acciones",
  VIOLATION: "Violaciones",
} satisfies Record<AuditDecision | "ALL", string>;

/** Plural labels of the decision filter. */
export const DECISION_FILTER_LABELS: Readonly<Record<AuditDecision | "ALL", string>> = localized({
  es: decisionFilterEs,
  en: {
    ALL: "All",
    ALLOW: "Allowed",
    DENY: "Denied",
    DEFER: "Deferred",
    ACTION: "Actions",
    VIOLATION: "Violations",
  } satisfies Widen<typeof decisionFilterEs>,
});

const triggerEs = {
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
} satisfies Record<TurnTrigger, string>;

export const TRIGGER_LABELS: Readonly<Record<TurnTrigger, string>> = localized({
  es: triggerEs,
  en: {
    IMPORTER_MESSAGE: "Importer message",
    SUPPLIER_EMAIL: "Supplier email",
    DOCUMENT_READ: "Document read",
    MILESTONE: "Milestone",
    ETA_CHANGED: "ETA change",
    EMAIL_BOUNCED: "Email bounced",
    CONTACT_CONFIRMED: "Contact confirmed",
    UPLOAD_COMPLETED: "Upload by link",
    BROKER_RELEASED: "Handed back to the agent",
    FOLLOWUP_DUE: "Scheduled follow-up",
  } satisfies Widen<typeof triggerEs>,
});

/** Who acted, grouped the way the filter offers it (`BROKER:<id>` is "Estudio"). */
export type ActorKind = "AGENT" | "SYSTEM" | "IMPORTER" | "SUPPLIER" | "FIRM" | "SEED" | "QA";

const actorEs = {
  AGENT: "Agente",
  SYSTEM: "Sistema (código determinista)",
  IMPORTER: "Importador",
  SUPPLIER: "Proveedor",
  FIRM: "Persona del estudio",
  SEED: "Datos sembrados",
  QA: "Ejecutor de escenarios",
} satisfies Record<ActorKind, string>;

export const ACTOR_LABELS: Readonly<Record<ActorKind, string>> = localized({
  es: actorEs,
  en: {
    AGENT: "Agent",
    SYSTEM: "System (deterministic code)",
    IMPORTER: "Importer",
    SUPPLIER: "Supplier",
    FIRM: "Firm member",
    SEED: "Seeded data",
    QA: "Scenario runner",
  } satisfies Widen<typeof actorEs>,
});

const actionEs = {
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
} as Readonly<Record<string, string>>;

export const ACTION_LABELS: Readonly<Record<string, string>> = localized({
  es: actionEs,
  en: {
    SEND_WHATSAPP: "WhatsApp to the importer",
    SEND_EMAIL: "Email to the supplier",
    CONSENT_GRANTED: "Opt-in recorded",
    CONSENT_REVOKED: "Opt-in revoked",
    CONTACT_CONFIRMED: "Contact confirmed",
    OPERATION_CREATED: "Operation created",
    DOCUMENT_READ: "Document read",
    TIMER_FIRED: "Timer fired",
    MILESTONE_FIRED: "Milestone fired",
    SKIPPED: "No action (no longer needed)",
    ETA_RESCHEDULED: "Milestones rescheduled for the ETA",
    GUARDRAIL_BLOCK: "Guardrail block",
    GUARDRAIL_MASK: "Data masked by the guardrail",
    APPROVED: "Dossier approved",
    REOPENED: "Dossier reopened",
    WAIVED: "Observation waived",
    TAKEOVER: "Conversation taken over",
    RELEASE: "Conversation handed back to the agent",
    CLOCK_ADVANCED: "Clock advanced",
    CLOCK_FORCED: "Clock advanced with the world busy",
    WORLD_CREATED: "World created",
    WORLD_RESET: "Demo reset",
    SIM_REPLY: "Reply from the simulated supplier",
    SEED_LOADED: "Data loaded",
    EVENT_DEAD_LETTERED: "Event with a processing error",
    TURN_CAP: "Turn cap",
    AGENT_FALLBACK: "Fallback send of the first request",
    AGENT_REFUSAL: "The agent referred it to the firm",
    CROSS_FIRM: "Data from another firm",
    INPUT_TOO_LARGE: "Request too large",
    ROLE_NOT_ALLOWED: "Role not allowed",
    RATE_LIMIT: "Hourly message limit",
    UNKNOWN_SENDER: "Unregistered sender",
    UNTRUSTED_SENDER: "Untrusted sender",
    SIM_UNTRUSTED: "Mail from outside the simulator",
  } satisfies Widen<typeof actionEs>,
});
