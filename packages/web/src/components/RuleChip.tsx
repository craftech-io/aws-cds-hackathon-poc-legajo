// A rule id as the firm reads it: what the rule means and the id the README, the flows and the audit
// log cite ("Horario del proveedor · CP-HOURS-SUPPLIER"), coloured by family: contact policy, Cedar,
// Lambda fence, or the matrix and guardrails. `compact` keeps only the id and moves the meaning to
// the accessible name, for dense tables.
import type { RuleId } from "@legajo/shared";
import { ruleFamilyOf, ruleLabel, type RuleFamily } from "../copy/rules";
import { Badge, type BadgeTone } from "./Badge";

const TONE_BY_FAMILY: Readonly<Record<RuleFamily, BadgeTone>> = {
  policy: "info",
  cedar: "warning",
  lambda: "neutral",
  other: "brand",
};

export function RuleChip({ ruleId, compact = false }: { readonly ruleId: RuleId; readonly compact?: boolean }) {
  const label = ruleLabel(ruleId);
  return (
    <Badge tone={TONE_BY_FAMILY[ruleFamilyOf(ruleId)]}>
      {compact ? (
        <code className="font-mono text-xs" title={label} aria-label={`${label} (${ruleId})`}>
          {ruleId}
        </code>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <span>{label}</span>
          <code className="font-mono text-xs font-normal">{ruleId}</code>
        </span>
      )}
    </Badge>
  );
}
