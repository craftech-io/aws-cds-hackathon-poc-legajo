// Turns, queue events, timers, the demo clock, quiescence, audit decisions and guardrail outcomes.
// Sources: docs/design-brief.md §5.1 and §5.5, docs/architecture.md §5, §7, §8 and §9.1,
// docs/tool-catalog.md "Tipos compartidos".
import { z } from "zod";

/** Event that starts a turn of the Harness (docs/design-brief.md §5.1). */
export const TurnTrigger = z.enum([
  "IMPORTER_MESSAGE",
  "SUPPLIER_EMAIL",
  "DOCUMENT_READ",
  "MILESTONE",
  "ETA_CHANGED",
  "EMAIL_BOUNCED",
  "CONTACT_CONFIRMED",
  "UPLOAD_COMPLETED",
  "BROKER_RELEASED",
  "FOLLOWUP_DUE",
]);
export type TurnTrigger = z.infer<typeof TurnTrigger>;

/** Types of the events of `OperationEvents.fifo` (docs/architecture.md §7). */
export const OperationEventType = z.enum([
  "INTAKE_DOCUMENT",
  "AGENT_TURN",
  "TIMER",
  "ETA_CHANGED",
  "DISPATCH_STATUS",
  "EMAIL_EVENT",
  "OUTBOUND_SEND",
  "ESCALATE",
  "HEALTH_PROBE",
  "POISON",
]);
export type OperationEventType = z.infer<typeof OperationEventType>;

/** Everything that has to happen at a simulated hour is a `TIMER#<kind>#<id>` (docs/architecture.md §8). */
export const TimerKind = z.enum(["MILESTONE", "DEFERRED_SEND", "FOLLOWUP_DUE", "SIM_REPLY", "READER_RETRY", "CONTACT_CHECK", "BOUNCE_RETRY"]);
export type TimerKind = z.infer<typeof TimerKind>;

/** Only SCHEDULED timers are in `GSI3 CLOCK#<clockId>`. */
export const TimerStatus = z.enum(["SCHEDULED", "FIRED", "SKIPPED", "CANCELLED"]);
export type TimerStatus = z.infer<typeof TimerStatus>;

/** What fired a timer: its real schedule, the paused clock, "fire now", or an ETA change that left it in the past. */
export const TimerFiredBy = z.enum(["SCHEDULER", "CLOCK", "MANUAL", "ETA_CHANGE"]);
export type TimerFiredBy = z.infer<typeof TimerFiredBy>;

/** The five milestones of an operation, in the order they fall before the ETA (CONTEXT.md, "Hito"). */
export const MilestoneName = z.enum(["DOCS_REQUEST", "FOLLOWUP", "FOLLOWUP_FINAL", "ESCALATION", "ARRIVAL"]);
export type MilestoneName = z.infer<typeof MilestoneName>;

/** Mode of a world's demo clock; every world starts PAUSED (ADR-0007). */
export const ClockMode = z.enum(["RUNNING", "PAUSED"]);
export type ClockMode = z.infer<typeof ClockMode>;

/** What keeps a world busy (`WORLD_BUSY`, docs/architecture.md §8): a turn, a queued event, a mail in transit, a scan. */
export const PendingKind = z.enum(["TURN", "EVENT", "MAIL", "SCAN"]);
export type PendingKind = z.infer<typeof PendingKind>;

/** `AuditLog.decision` (docs/architecture.md §5). */
export const AuditDecision = z.enum(["ALLOW", "DENY", "DEFER", "ACTION", "VIOLATION"]);
export type AuditDecision = z.infer<typeof AuditDecision>;

/** What a guardrail did with a text; only BLOCKED stops a turn, ANONYMIZED continues with G1's text. */
export const GuardrailAction = z.enum(["NONE", "ANONYMIZED", "BLOCKED"]);
export type GuardrailAction = z.infer<typeof GuardrailAction>;

/** Outcome of G2 on an outbound text, as the send tools report it (`Guardrail.action`). */
export const GuardrailOutcome = GuardrailAction.extract(["NONE", "BLOCKED"]);
export type GuardrailOutcome = z.infer<typeof GuardrailOutcome>;

/** `Guardrail` of docs/tool-catalog.md "Tipos compartidos". */
export const Guardrail = z.object({
  action: GuardrailOutcome,
  groundingScore: z.number().min(0).max(1).optional(),
});
export type Guardrail = z.infer<typeof Guardrail>;

/** Where a G1 block happened: the worker's pre-filter or the Harness (`GUARDRAIL_BLOCK.origin`). */
export const GuardrailOrigin = z.enum(["PREFILTER", "HARNESS"]);
export type GuardrailOrigin = z.infer<typeof GuardrailOrigin>;

/** Whose text was blocked; SYSTEM for a turn without inbound text (`GUARDRAIL_BLOCK.source`). */
export const GuardrailSource = z.enum(["IMPORTER", "SUPPLIER", "SYSTEM"]);
export type GuardrailSource = z.infer<typeof GuardrailSource>;
