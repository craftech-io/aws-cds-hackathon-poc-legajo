// Messages, WhatsApp buttons and templates, supplier contacts, consent and the supplier simulator.
// Sources: docs/tool-catalog.md "Tipos compartidos", docs/design-brief.md §3 (kind → channel matrix),
// docs/architecture-integrations.md §3 (simulator behaviours) and §4.3 (templates).
import { z } from "zod";

/** Every kind of message the system sends; `CP-KIND-CHANNEL` maps each one to its channel. */
export const MessageKind = z.enum([
  "DOCS_REQUEST",
  "REMINDER",
  "CORRECTION_REQUEST",
  "NO_ACTION_NEEDED",
  "CONTACT_REQUEST",
  "CONTACT_CONFIRMATION",
  "UPLOAD_LINK",
  "ETA_CHANGE",
  "ESCALATION_NOTICE",
  "ESCALATION",
  "APPROVAL_NOTICE",
  "DISPATCH_STATUS",
  "REPLY",
  "BROKER_MESSAGE",
  "OPT_OUT_CONFIRMATION",
  "OPERATION_CHOICE",
]);
export type MessageKind = z.infer<typeof MessageKind>;

/** Kinds `send_email` accepts: what the agent may write to a supplier (docs/tool-catalog.md). */
export const SupplierEmailKind = MessageKind.extract(["DOCS_REQUEST", "REMINDER", "CORRECTION_REQUEST", "ETA_CHANGE", "REPLY"]);
export type SupplierEmailKind = z.infer<typeof SupplierEmailKind>;

export const MessageDirection = z.enum(["IN", "OUT"]);
export type MessageDirection = z.infer<typeof MessageDirection>;

/** Result of a send through the outbound pipeline: sent, or deferred to `nextAllowedAt`. */
export const SendStatus = z.enum(["SENT", "DEFERRED"]);
export type SendStatus = z.infer<typeof SendStatus>;

/** Action of a WhatsApp button; the code turns each one into a nonce and writes its title. */
export const WaButtonAction = z.enum([
  "UPLOAD",
  "SUPPLIER_SENDS",
  "QUESTION",
  "OPT_OUT",
  "CONFIRM_CONTACT",
  "REJECT_CONTACT",
  "OTHER_CONTACT",
  "TALK_TO_FIRM",
  "CHOOSE_OPERATION",
]);
export type WaButtonAction = z.infer<typeof WaButtonAction>;

/** `UTILITY` templates in `es_AR` (docs/architecture-integrations.md §4.3). */
export const WhatsAppTemplateName = z.enum([
  "legajo_docs_pendientes",
  "legajo_recordatorio",
  "legajo_observacion_proveedor",
  "legajo_contacto_proveedor",
  "legajo_nuevo_plazo",
  "legajo_escalado",
  "legajo_aprobado",
  "despacho_estado",
]);
export type WhatsAppTemplateName = z.infer<typeof WhatsAppTemplateName>;

/** The agent only writes to an ACTIVE contact; BOUNCED and COMPLAINED are never used again. */
export const SupplierContactStatus = z.enum(["PENDING_CONFIRMATION", "ACTIVE", "BOUNCED", "COMPLAINED"]);
export type SupplierContactStatus = z.infer<typeof SupplierContactStatus>;

/** How the importer's contact gave the WhatsApp opt-in (`record_consent`). */
export const ConsentMedium = z.enum(["SIGNED_FORM", "EMAIL", "IN_PERSON"]);
export type ConsentMedium = z.infer<typeof ConsentMedium>;

/** Behaviour of the supplier simulator (docs/architecture-integrations.md §3). */
export const SupplierBehaviour = z.enum([
  "PROMPT",
  "SEEDED_ERROR",
  "SEEDED_ERROR_TWICE",
  "LATE",
  "NEVER",
  "WRONG_DOC",
  "UNKNOWN_DOC",
  "PROMISE",
  "AUTO_REPLY",
  "INJECTION",
  "BOUNCE",
  "COMPLAINT",
]);
export type SupplierBehaviour = z.infer<typeof SupplierBehaviour>;
