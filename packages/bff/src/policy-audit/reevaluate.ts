// Check (b) of `PolicyAudit` (docs/architecture.md §12): the contact policy re-evaluated with the
// data of the moment a message went out. The rules are the engine's (packages/bff/src/policy/,
// ADR-0012): `evaluateAsOf` judges the send at its own instant from the dated histories the connector
// keeps (consent, supplier authorization, contact status, control and dossier status; §5), so a
// revocation, a bounce or a takeover that happened after the send never makes a past send a violation,
// and one that was in force when it went out always does. What only exists at send time (the
// recipient fence of an email, the content rules) is not re-judged: as-of.ts skips it.
import { CONTACT_POLICY_RULES, type ContactPolicyRuleId } from "@legajo/shared";
import { type AsOfFacts, evaluateAsOf } from "../policy/as-of";

/** What the send looked like when it went out: the message and the rows whose histories decide it. */
export type SendFacts = AsOfFacts;

export interface RuleBreach {
  readonly ruleId: ContactPolicyRuleId;
  readonly detail: string;
}

/** Rules the re-evaluation runs, in the engine's order (docs/design-brief.md §5.7). */
export const REEVALUATED_RULES = CONTACT_POLICY_RULES;

/** Every rule the send breaks (or would defer) at `sentAtSim`; empty when the policy would allow it again. */
export function reevaluateSend(facts: SendFacts): RuleBreach[] {
  return evaluateAsOf(facts, { exhaustive: true })
    .evaluated.filter((entry) => entry.result === "DENY" || entry.result === "DEFER")
    .map((entry) => ({ ruleId: entry.ruleId, detail: entry.detail }));
}
