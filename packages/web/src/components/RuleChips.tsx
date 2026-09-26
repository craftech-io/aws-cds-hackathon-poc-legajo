// Rule ids as the bitácora, the pendings and the metrics list them: a known id gets its RuleChip,
// anything else (a decision word used as a key) a neutral code badge, so a new id never breaks a view.
import { isRuleId } from "@legajo/shared";
import { Fragment } from "react";
import { Badge } from "./Badge";
import { RuleChip } from "./RuleChip";

export function RuleIdChip({ id, compact = false }: { readonly id: string; readonly compact?: boolean }) {
  if (isRuleId(id)) return <RuleChip ruleId={id} compact={compact} />;
  return (
    <Badge>
      <code className="font-mono text-xs">{id}</code>
    </Badge>
  );
}

interface RuleChipsProps {
  readonly ids: readonly string[];
  /** Shown when there is no rule (e.g. "Sin reglas"); nothing by default. */
  readonly empty?: string;
  readonly compact?: boolean;
}

export function RuleChips({ ids, empty, compact = false }: RuleChipsProps) {
  if (ids.length === 0) return empty ? <span className="text-xs text-slate">{empty}</span> : null;
  // The spaces keep each id a separate word in the text of the row (search, copy, exports).
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <Fragment key={id}>
          {" "}
          <RuleIdChip id={id} compact={compact} />{" "}
        </Fragment>
      ))}
    </span>
  );
}
