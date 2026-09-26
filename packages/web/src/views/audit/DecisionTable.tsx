// The decisions of the bitácora as rows: when (simulated hour of the world, else real), what was
// decided and on what, the rules evaluated, the event that triggered it, who acted and the operation.
// Every stored code is shown in the firm's words; rule ids stay visible, as the README and the flows cite them.
import type { AuditDecision } from "@legajo/shared";
import { Badge, type BadgeTone } from "../../components/Badge";
import { RuleChips } from "../../components/RuleChips";
import { type Column, Table } from "../../components/Table";
import { formatSimDateTime } from "../../lib/format";
import { type AuditRow, actionLabel, actorLabel, operationNumberOfDecision, triggerLabel } from "./audit-model";
import { DECISION_LABELS, auditCopy } from "./copy";

const copy = auditCopy.list;

const TONES: Readonly<Record<AuditDecision, BadgeTone>> = {
  ALLOW: "success",
  DENY: "danger",
  DEFER: "warning",
  ACTION: "neutral",
  VIOLATION: "danger",
};

const COLUMNS: readonly Column<AuditRow>[] = [
  { id: "at", header: copy.at, cell: (row) => <time dateTime={row.atSim ?? row.ts}>{formatSimDateTime(row.atSim ?? row.ts)}</time> },
  { id: "decision", header: copy.decision, cell: (row) => <Badge tone={TONES[row.decision]}>{DECISION_LABELS[row.decision]}</Badge> },
  { id: "action", header: copy.action, cell: (row) => actionLabel(row.action) },
  { id: "rules", header: copy.rules, cell: (row) => <RuleChips ids={row.ruleIds} empty={copy.noRules} compact /> },
  { id: "trigger", header: copy.trigger, cell: (row) => triggerLabel(row.trigger) ?? "—" },
  { id: "actor", header: copy.actor, cell: (row) => actorLabel(row.actor) },
  { id: "operation", header: copy.operation, cell: (row) => operationNumberOfDecision(row) ?? "—" },
];

export function DecisionTable({ rows }: { readonly rows: readonly AuditRow[] }) {
  return <Table columns={COLUMNS} rows={rows} keyOf={(row) => row.decisionId} emptyTitle={copy.empty} caption={copy.title} variant="inset" />;
}
