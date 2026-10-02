// Ids of every rule a decision can cite: the contact policy (`CP-*`, docs/design-brief.md §5.7, in
// evaluation order), the Cedar statements of the Gateway (`CED-*`, §5.6), the Lambda fences
// (`LAM-*`, §5.6) and the few others the audit log names (responsibility matrix, guardrails). The
// engine lives in packages/bff/src/policy/ and the statements in infra/policy-rules.ts; this file
// only fixes the strings so flows, audit entries, Cedar and the console agree on them.
import { z } from "zod";
import { IsoInstant } from "./dates";
import { ToolTarget } from "./tools";

/** Contact policy rules in the order the engine evaluates them; the first denial cuts. */
export const CONTACT_POLICY_RULES = [
  "CP-CONTROL-BROKER",
  "CP-KIND-CHANNEL",
  "CP-RECIPIENT-FENCE",
  "CP-OPTIN",
  "CP-OPTOUT",
  "CP-SUPPLIER-AUTH",
  "CP-BOUNCED-CONTACT",
  "CP-APPROVED-SCOPE",
  "CP-HOURS-AR",
  "CP-HOURS-SUPPLIER",
  "CP-ONE-PER-DAY",
  "CP-WA-24H",
  "CP-NO-SENSITIVE-ASK",
  "CP-NO-FOREIGN-LINKS",
  // ADR-0015 §4: an email of a guest world goes out only inside its quota (last: every other rule decides first).
  "CP-WORLD-QUOTA",
] as const;
export const ContactPolicyRuleId = z.enum(CONTACT_POLICY_RULES);
export type ContactPolicyRuleId = z.infer<typeof ContactPolicyRuleId>;

type UpperTarget = Uppercase<ToolTarget>;

/** Permit of the Harness role over the tools of a target; created before any forbid. */
export function cedarPermitId(target: ToolTarget): `CED-PERMIT-${UpperTarget}` {
  return `CED-PERMIT-${target.toUpperCase() as UpperTarget}`;
}

/** `forbid unless context.input has sessionToken` for the tools of a target. */
export function cedarSessionId(target: ToolTarget): `CED-SESSION-${UpperTarget}` {
  return `CED-SESSION-${target.toUpperCase() as UpperTarget}`;
}

export const CEDAR_STATEMENT_IDS = [
  ...ToolTarget.options.map(cedarPermitId),
  ...ToolTarget.options.map(cedarSessionId),
  "CED-EMAIL-SUPPLIER-ONLY",
  "CED-WA-IMPORTER-ONLY",
  "CED-NO-APPROVE",
  "CED-RISK-ASSUMPTIONS",
  "CED-KILL-SWITCH",
] as const;
export const CedarStatementId = z.enum(CEDAR_STATEMENT_IDS);
export type CedarStatementId = z.infer<typeof CedarStatementId>;

/** Checks the target Lambdas apply themselves, because Cedar sees neither the session nor the registry. */
export const LAMBDA_FENCE_IDS = [
  "LAM-STRICT",
  "LAM-OP-SCOPE",
  "LAM-RECIPIENT",
  "LAM-SUPPLIER-AUTH",
  "LAM-CONTROL",
  "LAM-ATTACHMENT",
  "LAM-TRIGGER",
  "LAM-EVIDENCE",
  "LAM-CALLER",
] as const;
export const LambdaFenceId = z.enum(LAMBDA_FENCE_IDS);
export type LambdaFenceId = z.infer<typeof LambdaFenceId>;

/** Responsibility matrix (`assign_responsible`) and the two guardrails. */
export const OTHER_RULE_IDS = ["RESP-MATRIX", "G1", "G2"] as const;

export const RuleId = z.enum([...CONTACT_POLICY_RULES, ...CEDAR_STATEMENT_IDS, ...LAMBDA_FENCE_IDS, ...OTHER_RULE_IDS]);
export type RuleId = z.infer<typeof RuleId>;

export function isRuleId(value: unknown): value is RuleId {
  return RuleId.safeParse(value).success;
}

/** `PolicyResult` of docs/tool-catalog.md "Tipos compartidos", as the send tools report it. */
export const PolicyResult = z.object({
  allowed: z.boolean(),
  ruleIds: z.array(ContactPolicyRuleId),
  reason: z.string().optional(),
  nextAllowedAt: IsoInstant.optional(),
});
export type PolicyResult = z.infer<typeof PolicyResult>;
