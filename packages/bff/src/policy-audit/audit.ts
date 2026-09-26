// `policy_audit` (docs/architecture.md §12, docs/tool-catalog.md, FL-060): two checks for every
// message that went out of an operation of the firm (or of one world):
//
//   (a) NO_ALLOW       there is an `ALLOW` decision with the same `messageId` in `AuditLog` (a send
//                      that skipped the outbound pipeline has none)
//   (b) REEVALUATION   the policy re-evaluated with the facts of that moment, rebuilt from the dated
//                      histories, still allows it (reevaluate.ts)
//
// A failed check writes one `AuditLog VIOLATION` (once per message and check, whatever how often the
// audit runs) and one log line the `PolicyViolations` metric filter counts. It never writes anything
// else and never reads a message body.
import type { ContactPolicyRuleId } from "@legajo/shared";
import type { Connector } from "../connector/index";
import type { Message } from "../domain/conversations";
import type { Operation } from "../domain/operations";
import type { Logger } from "../lib/log";
import { REEVALUATED_RULES, type RuleBreach, reevaluateSend } from "./reevaluate";

/** Metric of docs/architecture.md §12 and the log event its filter matches. */
export const POLICY_VIOLATIONS_METRIC = "PolicyViolations";
export const POLICY_VIOLATION_LOG = "policy_audit.violation";

/** `Runtime/IDEMP#POLICY_AUDIT#<messageId>#<check>`: one violation row per message and check. */
export const POLICY_AUDIT_MARK = "POLICY_AUDIT";

export type AuditCheck = "NO_ALLOW" | "REEVALUATION";

/** Statuses of a message that left the building (queued, deferred or failed ones never did). */
const SENT_STATUSES: ReadonlySet<Message["status"]> = new Set(["SENT", "DELIVERED", "READ", "DELAYED", "BOUNCED", "COMPLAINED"]);

export function wentOut(message: Pick<Message, "direction" | "status">): boolean {
  return message.direction === "OUT" && SENT_STATUSES.has(message.status);
}

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
  readonly violations: readonly Violation[];
}

export interface PolicyAuditDeps {
  readonly data: Connector;
  readonly log: Logger;
  /** Real time of the run (audit stamps and idempotency marks). */
  readonly now: () => Date;
  readonly correlationId?: string;
}

async function factsOf(data: Connector, operation: Operation, message: Message) {
  const consent = message.channel === "WHATSAPP" && message.counterpart === "IMPORTER" ? await data.parties.getConsent(operation.importerId) : undefined;
  const supplierEmail = message.channel === "EMAIL" && message.counterpart === "SUPPLIER";
  const authorization = supplierEmail ? await data.parties.getAuthorization(operation.importerId, operation.supplierId) : undefined;
  const contact = supplierEmail && message.contactId !== undefined ? await data.parties.findContact(operation.supplierId, message.contactId) : undefined;
  return {
    message,
    operation,
    ...(consent === undefined ? {} : { consent }),
    ...(authorization === undefined ? {} : { authorization }),
    ...(contact === undefined ? {} : { contact }),
  };
}

async function recordViolation(deps: PolicyAuditDeps, operation: Operation, message: Message, check: AuditCheck, breaches: readonly RuleBreach[]): Promise<Violation> {
  const ruleIds = breaches.map((breach) => breach.ruleId);
  const atReal = deps.now().toISOString();
  const recorded = await deps.data.runtime.claimIdempotency({ source: POLICY_AUDIT_MARK, id: `${message.messageId}#${check}`, atReal });
  deps.log.error(POLICY_VIOLATION_LOG, { metric: POLICY_VIOLATIONS_METRIC, check, operationId: operation.operationId, messageId: message.messageId, ruleIds, recorded });
  if (recorded) {
    await deps.data.audit.record({
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
  }
  return { operationId: operation.operationId, messageId: message.messageId, check, ruleIds, recorded };
}

/** Both checks for one message; the violations it produced (none for a clean send). */
export async function auditMessage(deps: PolicyAuditDeps, operation: Operation, message: Message): Promise<Violation[]> {
  const violations: Violation[] = [];
  const allow = await deps.data.audit.findAllowForMessage(operation.operationId, message.messageId);
  if (allow === undefined || allow.evaluated.length + allow.ruleIds.length === 0) violations.push(await recordViolation(deps, operation, message, "NO_ALLOW", []));
  const breaches = reevaluateSend(await factsOf(deps.data, operation, message));
  if (breaches.length > 0) violations.push(await recordViolation(deps, operation, message, "REEVALUATION", breaches));
  return violations;
}

/** Runs both checks over every message that went out of the scope's operations. */
export async function runPolicyAudit(deps: PolicyAuditDeps, scope: PolicyAuditScope): Promise<PolicyAuditReport> {
  const operations = await deps.data.operations.listOperations(scope.firmId, scope.clockId === undefined ? {} : { clockId: scope.clockId });
  const since = scope.sinceReal === undefined ? undefined : Date.parse(scope.sinceReal);
  let messagesChecked = 0;
  const violations: Violation[] = [];
  for (const operation of operations) {
    const messages = await deps.data.conversations.listMessages(operation.operationId, { direction: "OUT" });
    for (const message of messages) {
      if (!wentOut(message) || (since !== undefined && Date.parse(message.sentAtReal) < since)) continue;
      messagesChecked += 1;
      violations.push(...(await auditMessage(deps, operation, message)));
    }
  }
  deps.log.info("policy_audit.done", { firmId: scope.firmId, clockId: scope.clockId ?? null, operations: operations.length, messagesChecked, violations: violations.length });
  return { firmId: scope.firmId, ...(scope.clockId === undefined ? {} : { clockId: scope.clockId }), operations: operations.length, messagesChecked, violations };
}
