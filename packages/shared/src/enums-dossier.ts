// The dossier and what happens to it: documents, readings, observations, responsibility, customs
// dispatch and escalations. Sources: docs/tool-catalog.md "Tipos compartidos", CONTEXT.md,
// docs/architecture-integrations.md §5 (reader contract) and §6 (customs events), docs/seed-spec.md §11.
import { z } from "zod";

/** The three documents of a dossier, and only those (CONTEXT.md, "Documento"). */
export const DocType = z.enum(["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"]);
export type DocType = z.infer<typeof DocType>;

/** Only the reader (a reading without blocking observations) or a broker's waiver make a document VALID. */
export const DocStatus = z.enum(["MISSING", "RECEIVED", "WITH_OBSERVATION", "VALID"]);
export type DocStatus = z.infer<typeof DocStatus>;

/** Parties of an operation; also the values of `responsibleParty`. */
export const Party = z.enum(["IMPORTER", "SUPPLIER", "BROKER"]);
export type Party = z.infer<typeof Party>;

/**
 * Default responsible of the firm's responsibility matrix (docs/seed-spec.md §11): a party, or
 * `SENDER` (whoever sent the version, for `LOW_CONFIDENCE`), which the matrix resolves per version.
 */
export const MatrixResponsible = z.enum([...Party.options, "SENDER"]);
export type MatrixResponsible = z.infer<typeof MatrixResponsible>;

/** Only a human moves a dossier to APPROVED (ADR-0010). */
export const DossierStatus = z.enum(["OPEN", "READY_FOR_REVIEW", "APPROVED", "REOPENED"]);
export type DossierStatus = z.infer<typeof DossierStatus>;

export const ObservationStatus = z.enum(["OPEN", "CORRECTION_REQUESTED", "RESOLVED", "ESCALATED", "WAIVED_BY_BROKER"]);
export type ObservationStatus = z.infer<typeof ObservationStatus>;

/** Observation codes of the reader contract (`Reading.observations[].code`). */
export const ObservationCode = z.enum([
  "GROSS_WEIGHT_MISMATCH",
  "NET_WEIGHT_MISMATCH",
  "INVOICE_NUMBER_MISMATCH",
  "INCOTERM_MISMATCH",
  "BUYER_DATA_MISMATCH",
  "ORIGIN_MISMATCH",
  "PACKAGES_MISMATCH",
  "MISSING_SIGNATURE",
  "MISSING_STAMP",
  "LOW_CONFIDENCE",
]);
export type ObservationCode = z.infer<typeof ObservationCode>;

export const ObservationSeverity = z.enum(["BLOCKING", "WARNING"]);
export type ObservationSeverity = z.infer<typeof ObservationSeverity>;

/** `Reading.status`: an UNRECOGNIZED document goes to the broker (ADR-0003). */
export const ReadingStatus = z.enum(["RECOGNIZED", "UNRECOGNIZED", "ERROR"]);
export type ReadingStatus = z.infer<typeof ReadingStatus>;

/** `Reading.matchedBy`: how the reader found its ground truth. */
export const ReadingMatchedBy = z.enum(["SHA256", "EMBEDDED_ID", "NONE"]);
export type ReadingMatchedBy = z.infer<typeof ReadingMatchedBy>;

/** Path a document version came in by (`read_document.source.channel`). */
export const DocumentSourceChannel = z.enum(["EMAIL", "WHATSAPP", "UPLOAD_LINK", "CONSOLE"]);
export type DocumentSourceChannel = z.infer<typeof DocumentSourceChannel>;

/** `Operation.dispatch.status` (`NONE` until the first customs event, CONTEXT.md "Estado del despacho"). */
export const DispatchStatus = z.enum(["NONE", "OFICIALIZADO", "CANAL_ASIGNADO", "LIBERADO"]);
export type DispatchStatus = z.infer<typeof DispatchStatus>;

/** Customs channel of `CANAL_ASIGNADO`. */
export const CustomsChannel = z.enum(["VERDE", "NARANJA", "ROJO"]);
export type CustomsChannel = z.infer<typeof CustomsChannel>;

/** `Operation.control`: with BROKER no event produces a turn (CP-CONTROL-BROKER). */
export const ConversationControl = z.enum(["AGENT", "BROKER"]);
export type ConversationControl = z.infer<typeof ConversationControl>;

/** Reasons of a handoff to the broker (docs/design-brief.md §5.8). */
export const EscalationReason = z.enum([
  "MISSING_AT_ETA_48H",
  "OBSERVATION_ATTEMPTS",
  "OUT_OF_CHECKLIST",
  "IMPORTER_ASKED",
  "UNRECOGNIZED_DOCUMENT",
  "NO_VALID_CONTACT",
  "UNTRUSTED_SENDER",
  "OPTED_OUT",
  "READER_UNAVAILABLE",
  "OTHER",
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

/** The only reasons the agent may pass to `escalate_to_broker`; the rest are decided by code. */
export const AgentEscalationReason = EscalationReason.extract(["OUT_OF_CHECKLIST", "IMPORTER_ASKED", "OTHER"]);
export type AgentEscalationReason = z.infer<typeof AgentEscalationReason>;

