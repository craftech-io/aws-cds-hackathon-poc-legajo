// A rule id as the firm reads it: what the rule means and the id the README, the flows and the audit
// log cite ("Horario del proveedor · CP-HOURS-SUPPLIER"), coloured by family: contact policy, Cedar,
// Lambda fence, or the matrix and guardrails. `compact` keeps only the id and moves the meaning to
// the accessible name, for dense tables. The public landing uses the `dark` tone over its harbour
// bands and passes `label` in the page's language (docs/landing-spec.md §1.6).
import type { RuleId } from "@legajo/shared";
import { ruleFamilyOf, ruleLabel, type RuleFamily } from "../copy/rules";
import { Badge, type BadgeTone } from "./Badge";

const TONE_BY_FAMILY: Readonly<Record<RuleFamily, BadgeTone>> = {
  policy: "info",
  cedar: "warning",
  lambda: "neutral",
  other: "brand",
};

interface RuleChipProps {
  readonly ruleId: RuleId;
  readonly compact?: boolean;
  /** `dark`: over the landing's harbour bands; `paper`: over its light sections. `light` is the console's. */
  readonly tone?: "light" | "dark" | "paper";
  /** What the rule means, when the page is not in Spanish. */
  readonly label?: string;
}

export function RuleChip({ ruleId, compact = false, tone = "light", label = ruleLabel(ruleId) }: RuleChipProps) {
  if (tone !== "light") {
    const dark = tone === "dark";
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-semibold ${dark ? "border-harbor-700 bg-harbor-900 text-foam" : "border-rule bg-manifest text-ink"}`}>
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dark ? "bg-glass" : "bg-glass-ink"}`} />
        {compact ? null : <span>{label}</span>}
        <code className={`font-mono text-xs font-normal ${dark ? "text-foam-muted" : "text-ink-muted"}`} {...(compact ? { title: label, "aria-label": `${label} (${ruleId})` } : {})}>
          {ruleId}
        </code>
      </span>
    );
  }
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
