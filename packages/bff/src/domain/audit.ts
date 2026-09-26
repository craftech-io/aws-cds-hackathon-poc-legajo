// `AuditLog` (docs/architecture.md §5): append-only decisions, partitioned by firm and month. Every
// send carries `ALLOW` (or `DENY`/`DEFER`) with the rules the policy evaluated, every effect an
// `ACTION`, and `PolicyAudit` writes `VIOLATION`. Written with `attribute_not_exists`, never updated.
import { z } from "zod";
import {
  AuditDecision,
  BrokerId,
  ClockId,
  ContactId,
  DocVersionId,
  FirmId,
  ImporterId,
  MessageId,
  ObservationId,
  OperationId,
  RuleId,
  SupplierId,
} from "@legajo/shared";
import { Actor, JsonObject, Month, ZonedInstant, defineEntity } from "./common";
import { EscalationId } from "./operations";

/** AuditLog keeps 12 months (docs/architecture.md §5). */
export const AUDIT_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Outcome of one rule for one decision (the console's "decisiones por regla"). */
export const RuleOutcome = z.enum(["PASS", "DENY", "DEFER", "SKIP"]);
export type RuleOutcome = z.infer<typeof RuleOutcome>;

export const EvaluatedRule = z.object({
  ruleId: RuleId,
  result: RuleOutcome,
  detail: z.string().max(300).optional(),
});
export type EvaluatedRule = z.infer<typeof EvaluatedRule>;

export const DecisionRefs = z
  .object({
    operationId: OperationId.optional(),
    turnId: z.string().min(1).max(64).optional(),
    messageId: MessageId.optional(),
    observationId: ObservationId.optional(),
    docVersionId: DocVersionId.optional(),
    escalationId: EscalationId.optional(),
    timerKey: z.string().min(1).max(100).optional(),
    eventId: z.string().min(1).max(128).optional(),
    importerId: ImporterId.optional(),
    supplierId: SupplierId.optional(),
    contactId: ContactId.optional(),
    brokerId: BrokerId.optional(),
    mailId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type DecisionRefs = z.infer<typeof DecisionRefs>;

/** Action names are SCREAMING_SNAKE_CASE (`CONSENT_GRANTED`, `SEND_WHATSAPP`, `GUARDRAIL_BLOCK`). */
export const AuditAction = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "expected an UPPER_SNAKE_CASE action");

export const Decision = defineEntity({
  decisionId: z.string().min(1).max(64),
  firmId: FirmId,
  /** Month partition of the item (`FIRM#<firmId>#<yyyy-mm>`), from `ts`. */
  month: Month,
  /** Canonical UTC sort instant: the simulated time of the decision in a world, else the real one. */
  ts: ZonedInstant,
  decision: AuditDecision,
  action: AuditAction,
  ruleIds: z.array(RuleId).default([]),
  evaluated: z.array(EvaluatedRule).default([]),
  messageId: MessageId.optional(),
  trigger: z.string().max(64).optional(),
  actor: Actor,
  refs: DecisionRefs.default({}),
  reason: z.string().max(500).optional(),
  clockId: ClockId.optional(),
  operationId: OperationId.optional(),
  atSim: ZonedInstant.optional(),
  atReal: ZonedInstant,
  correlationId: z.string().max(64).optional(),
  detail: JsonObject.optional(),
});
export type Decision = z.output<typeof Decision>;
