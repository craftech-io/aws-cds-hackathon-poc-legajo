// Bitácora (`/app/audit`, docs/design-brief.md §6, FL-086): the policy-violations counter (it must be
// 0) next to the DENY and DEFER decisions by rule, and the decisions of the world, filterable by
// operation and decision (`audit.list` filters them) and by rule and actor (filtered here, over what
// the list brought). Everything follows the world at the shell's cadence.
import { AuditDecision } from "@legajo/shared";
import { useState } from "react";
import { FilterPills } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { Section } from "../../components/Section";
import { SelectField } from "../../components/SelectField";
import { StatGrid, StatTile } from "../../components/StatTile";
import { useSession } from "../../context/SessionContext";
import { useLiveRemote } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import { dataOf } from "../../lib/use-remote";
import { actorOptions, decisionInput, filterDecisions, ruleCountRows, ruleOptionLabel, ruleOptions, totals } from "./audit-model";
import { ACTOR_LABELS, type ActorKind, DECISION_FILTER_LABELS, auditCopy } from "./copy";
import { DecisionTable } from "./DecisionTable";
import { RuleCountsTable } from "./RuleCounts";

type DecisionFilter = AuditDecision | "ALL";
const ALL = "ALL";

const DECISION_OPTIONS = (["ALL", ...AuditDecision.options] as const).map((value) => ({ value, label: DECISION_FILTER_LABELS[value] }));

function Counters() {
  const { trpc } = useSession();
  const violations = useLiveRemote("audit.violations", (signal) => trpc.audit.violations.query({}, { signal }));
  const byRule = useLiveRemote("audit.decisionsByRule", (signal) => trpc.audit.decisionsByRule.query({}, { signal }));
  const copy = auditCopy.counters;
  const count = dataOf(violations.state)?.count;
  const sums = totals(ruleCountRows(dataOf(byRule.state)?.byRule ?? {}));
  return (
    <div className="mb-6 flex flex-col gap-6">
      <section aria-label={copy.title}>
        <RemoteBlock state={violations.state} onRetry={violations.reload}>
          {() => (
            <StatGrid>
              <StatTile label={copy.violations} value={count ?? "—"} tone={count === 0 ? "success" : "danger"} hint={copy.violationsHint} />
              <StatTile label={copy.denied} value={sums.deny} hint={copy.evidenceHint} />
              <StatTile label={copy.deferred} value={sums.defer} />
            </StatGrid>
          )}
        </RemoteBlock>
      </section>
      <Section id="audit-by-rule" title={auditCopy.byRule.title} description={auditCopy.byRule.description}>
        <RemoteBlock state={byRule.state} onRetry={byRule.reload}>
          {(data) => <RuleCountsTable byRule={data.byRule} />}
        </RemoteBlock>
      </Section>
    </div>
  );
}

function Decisions() {
  const { trpc } = useSession();
  const [operationId, setOperationId] = useState<string>(ALL);
  const [decision, setDecision] = useState<DecisionFilter>(ALL);
  const [ruleId, setRuleId] = useState<string>(ALL);
  const [actor, setActor] = useState<ActorKind | typeof ALL>(ALL);
  const operations = useLiveRemote("audit:operations", (signal) => trpc.operations.list.query({}, { signal }));
  const input = { ...(operationId === ALL ? {} : { operationId }), ...decisionInput(decision) };
  const list = useLiveRemote(`audit.list:${JSON.stringify(input)}`, (signal) => trpc.audit.list.query(input, { signal }));
  const copy = auditCopy.filters;
  const rows = dataOf(list.state)?.decisions ?? [];

  const operationOptions = [
    { value: ALL, label: copy.allOperations },
    ...(dataOf(operations.state)?.operations ?? []).map((operation) => ({ value: operation.operationId, label: operation.operationNumber })),
  ];
  const rules = [...new Set([...ruleOptions(rows), ...(ruleId === ALL ? [] : [ruleId])])];
  const actors = [...new Set([...actorOptions(rows), ...(actor === ALL ? [] : [actor])])];

  return (
    <Section id="audit-decisions" title={auditCopy.list.title} description={auditCopy.list.description}>
      <div role="group" aria-label={copy.label} className="mb-4 flex flex-wrap items-end gap-4">
        <SelectField label={copy.operation} value={operationId} options={operationOptions} onChange={setOperationId} className="min-w-48" />
        <SelectField label={copy.rule} value={ruleId} options={[{ value: ALL, label: copy.allRules }, ...rules.map((id) => ({ value: id, label: ruleOptionLabel(id) }))]} onChange={setRuleId} className="min-w-56" />
        <SelectField
          label={copy.actor}
          value={actor}
          options={[{ value: ALL, label: copy.allActors }, ...actors.map((kind) => ({ value: kind, label: ACTOR_LABELS[kind] }))]}
          onChange={setActor}
          className="min-w-56"
        />
      </div>
      <div className="mb-4">
        <FilterPills label={copy.decision} options={DECISION_OPTIONS} value={decision} onChange={setDecision} />
      </div>
      <RemoteBlock state={list.state} onRetry={list.reload}>
        {() => <DecisionTable rows={filterDecisions(rows, { ...(ruleId === ALL ? {} : { ruleId }), ...(actor === ALL ? {} : { actor }) })} />}
      </RemoteBlock>
    </Section>
  );
}

export default function View() {
  const view = consoleCopy.views.audit;
  return (
    <div>
      <PageHeader title={view.title} description={view.description} />
      <Counters />
      <Decisions />
    </div>
  );
}
