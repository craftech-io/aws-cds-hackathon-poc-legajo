// `policy_audit` (docs/architecture.md §12, docs/tool-catalog.md, FL-060): two checks for every
// message that went out of an operation of the firm (or of one world):
//
//   (a) NO_ALLOW       there is an `ALLOW` decision with the same `messageId` in `AuditLog` (a send
//                      that skipped the outbound pipeline has none)
//   (b) REEVALUATION   the policy re-evaluated with the facts of that moment, rebuilt from the dated
//                      histories, still allows it (reevaluate.ts)
//
// A failed check first logs the line the `PolicyViolations` metric filter counts and then writes one
// `AuditLog VIOLATION`, once per message and check whatever how often the audit runs (a conditional
// put on a decision id derived from `<messageId>#<check>`; `AuditLog` is the only table it writes).
// A message whose audit fails is logged and skipped: one failure never ends the run. It never reads
// a message body.
import type { ContactPolicyRuleId } from "@legajo/shared";
import type { Connector } from "../connector/index";
import type { Message } from "../domain/conversations";
import type { Operation } from "../domain/operations";
import type { Logger } from "../lib/log";
import type { BusinessHours } from "../services/business-hours";
import { importerHoursReader, sendFactsOf } from "./facts";
import { REEVALUATED_RULES, type RuleBreach, reevaluateSend } from "./reevaluate";
import { wentOut } from "./time-rules";

/** Metric of docs/architecture.md §12 and the log event its filter matches. */
export const POLICY_VIOLATIONS_METRIC = "PolicyViolations";
export const POLICY_VIOLATION_LOG = "policy_audit.violation";

/** A message the audit could not finish (logged; the run goes on). */
export const POLICY_AUDIT_FAILED_LOG = "policy_audit.message_failed";

export type AuditCheck = "NO_ALLOW" | "REEVALUATION";

export interface PolicyAuditScope {
  readonly firmId: string;
  /** Only the operations of this world (`policyAudit.run` of a scenario); every world of the firm otherwise. */
  readonly clockId?: string;
  /** Only messages sent at or after this real instant (the daily run looks back a window). */
  readonly sinceReal?: string;
}

export interface Violation {
  readonly operationId: string;
  readonly messageId: string;
  readonly check: AuditCheck;
  readonly ruleIds: readonly ContactPolicyRuleId[];
  /** False when an earlier run already recorded it. */
  readonly recorded: boolean;
}

export interface PolicyAuditReport {
  readonly firmId: string;
  readonly clockId?: string;
  readonly operations: number;
  readonly messagesChecked: number;
  /** Messages whose audit failed (logged with `policy_audit.message_failed`, not audited). */
  readonly failed: number;
  readonly violations: readonly Violation[];
}

export interface PolicyAuditDeps {
  readonly data: Connector;
  readonly log: Logger;
  /** Real time of the run (audit stamps). */
  readonly now: () => Date;
  readonly correlationId?: string;
}

async function recordViolation(deps: PolicyAuditDeps, operation: Operation, message: Message, check: AuditCheck, breaches: readonly RuleBreach[]): Promise<Violation> {
  const ruleIds = breaches.map((breach) => breach.ruleId);
  const atReal = deps.now().toISOString();
  // The metric counts the finding before anything is written, so a failed write never hides it.
  deps.log.error(POLICY_VIOLATION_LOG, { metric: POLICY_VIOLATIONS_METRIC, check, operationId: operation.operationId, messageId: message.messageId, ruleIds });
  const { recorded } = await deps.data.audit.recordOnce(`${message.messageId}#${check}`, {
    firmId: operation.firmId,
    clockId: operation.clockId,
    operationId: operation.operationId,
    decision: "VIOLATION",
    action: check === "NO_ALLOW" ? "SEND_WITHOUT_ALLOW" : "POLICY_REEVALUATION_FAILED",
    ruleIds,
    evaluated: breaches.map((breach) => ({ ruleId: breach.ruleId, result: "DENY" as const, detail: breach.detail })),
    messageId: message.messageId,
    actor: "SYSTEM",
    trigger: "POLICY_AUDIT",
    refs: { operationId: operation.operationId, messageId: message.messageId },
    reason: check === "NO_ALLOW" ? "a message went out without an ALLOW decision" : "the policy of that moment would not have allowed this message",
    atSim: message.sentAtSim,
    atReal,
    ...(deps.correlationId === undefined ? {} : { correlationId: deps.correlationId }),
    detail: { check, reevaluated: [...REEVALUATED_RULES] },
  });
  return { operationId: operation.operationId, messageId: message.messageId, check, ruleIds, recorded };
}

/** Both checks for one message; the violations it produced (none for a clean send). */
export async function auditMessage(deps: PolicyAuditDeps, operation: Operation, message: Message, importerHours: () => Promise<BusinessHours> = importerHoursReader(deps.data)): Promise<Violation[]> {
  const violations: Violation[] = [];
  const allow = await deps.data.audit.findAllowForMessage(operation.operationId, message.messageId);
  if (allow === undefined || allow.evaluated.length + allow.ruleIds.length === 0) violations.push(await recordViolation(deps, operation, message, "NO_ALLOW", []));
  const breaches = reevaluateSend(await sendFactsOf({ data: deps.data, operation, message, allow, importerHours }));
  if (breaches.length > 0) violations.push(await recordViolation(deps, operation, message, "REEVALUATION", breaches));
  return violations;
}

/** Runs both checks over every message that went out of the scope's operations. */
export async function runPolicyAudit(deps: PolicyAuditDeps, scope: PolicyAuditScope): Promise<PolicyAuditReport> {
  const operations = await deps.data.operations.listOperations(scope.firmId, scope.clockId === undefined ? {} : { clockId: scope.clockId });
  const since = scope.sinceReal === undefined ? undefined : Date.parse(scope.sinceReal);
  const importerHours = importerHoursReader(deps.data);
  let messagesChecked = 0;
  let failed = 0;
  const violations: Violation[] = [];
  for (const operation of operations) {
    const messages = await deps.data.conversations.listMessages(operation.operationId, { direction: "OUT" });
    for (const message of messages) {
      if (!wentOut(message) || (since !== undefined && Date.parse(message.sentAtReal) < since)) continue;
      messagesChecked += 1;
      try {
        violations.push(...(await auditMessage(deps, operation, message, importerHours)));
      } catch (error) {
        failed += 1;
        deps.log.error(POLICY_AUDIT_FAILED_LOG, { operationId: operation.operationId, messageId: message.messageId, error: error instanceof Error ? error.name : "unknown" });
      }
    }
  }
  deps.log.info("policy_audit.done", { firmId: scope.firmId, clockId: scope.clockId ?? null, operations: operations.length, messagesChecked, failed, violations: violations.length });
  return { firmId: scope.firmId, ...(scope.clockId === undefined ? {} : { clockId: scope.clockId }), operations: operations.length, messagesChecked, failed, violations };
}
