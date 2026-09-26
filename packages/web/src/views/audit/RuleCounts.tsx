// DENY and DEFER decisions counted by rule (`audit.decisionsByRule`, `metrics.summary` detail): the
// evidence that sits next to the "0 violaciones" in the bitácora and in the metrics. Each rule reads
// as its chip, meaning and id.
import { RuleIdChip } from "../../components/RuleChips";
import { type Column, Table } from "../../components/Table";
import { type RuleCountRow, ruleCountRows } from "./audit-model";
import { auditCopy } from "./copy";

const copy = auditCopy.byRule;

const COLUMNS: readonly Column<RuleCountRow>[] = [
  { id: "rule", header: copy.rule, cell: (row) => <RuleIdChip id={row.ruleId} /> },
  { id: "deny", header: copy.denied, cell: (row) => row.deny, align: "right" },
  { id: "defer", header: copy.deferred, cell: (row) => row.defer, align: "right" },
];

export function RuleCountsTable({ byRule }: { readonly byRule: Readonly<Record<string, { readonly deny: number; readonly defer: number }>> }) {
  return <Table columns={COLUMNS} rows={ruleCountRows(byRule)} keyOf={(row) => row.ruleId} emptyTitle={copy.empty} caption={copy.title} variant="inset" />;
}
