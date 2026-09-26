// How a decision leaves the engine: the tool error code of a denial (docs/tool-catalog.md,
// Convenciones) and the `PolicyResult` the send tools return (docs/tool-catalog.md "Tipos
// compartidos", packages/shared/src/rules.ts).
import type { ContactPolicyRuleId, PolicyResult } from "@legajo/shared";
import type { RuleOutcome } from "../domain/audit";
import type { PolicyDecision, PolicyErrorCode } from "./types";

/** Denials with their own code; every other rule answers `POLICY_DENIED`. */
const ERROR_CODES: Partial<Readonly<Record<ContactPolicyRuleId, PolicyErrorCode>>> = {
  "CP-CONTROL-BROKER": "CONTROL_BROKER",
  "CP-RECIPIENT-FENCE": "RECIPIENT_NOT_ALLOWED",
  "CP-WA-24H": "TEMPLATE_REQUIRED",
  // The content rules are part of the deterministic verification of the text (docs/design-brief.md §5.5).
  "CP-NO-SENSITIVE-ASK": "GROUNDING_FAIL",
  "CP-NO-FOREIGN-LINKS": "GROUNDING_FAIL",
};

/** The tool error code of a rule that denied or deferred. */
export function policyErrorCode(ruleId: ContactPolicyRuleId, result: RuleOutcome): PolicyErrorCode {
  if (result === "DEFER") return "DEFERRED";
  return ERROR_CODES[ruleId] ?? "POLICY_DENIED";
}

/** The `policyResult` of `send_whatsapp` and `send_email`. */
export function toPolicyResult(decision: PolicyDecision): PolicyResult {
  return {
    allowed: decision.allowed,
    ruleIds: [...decision.ruleIds],
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.nextAllowedAt === undefined ? {} : { nextAllowedAt: decision.nextAllowedAt }),
  };
}
