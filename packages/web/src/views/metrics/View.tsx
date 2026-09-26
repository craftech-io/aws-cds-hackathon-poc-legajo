// Métricas (`/app/metrics`, docs/design-brief.md §8, FL-085): one tab per source, never mixed in a
// number ("Este mundo", the batch with the real agent and the batch with the scripted agent). Every
// KPI says its N, where it comes from and its label (medido, agente guionado or supuesto); the manual
// baseline shows its declared breakdown; the violations counter stands next to the DENY and DEFER
// decisions by rule; and the rows behind a tab export as CSV (`metrics.export`).
import { useState } from "react";
import { Button } from "../../components/Button";
import { FilterPills } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { Section } from "../../components/Section";
import { StatGrid, StatTile } from "../../components/StatTile";
import { type Column, Table } from "../../components/Table";
import { useSession } from "../../context/SessionContext";
import { useLiveRemote } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import { formatNumber } from "../../lib/format";
import { useAction } from "../../lib/use-remote";
import { ActionOutcome } from "../clock/parts";
import { RuleCountsTable } from "../audit/RuleCounts";
import { metricsCopy } from "./copy";
import { type Baseline, type BaselineRow, type KpiCard, type KpiTabValue, type MetricsSummary, TABS, baselineOf, decisionsByRuleOf, kpiCards, summaryLine } from "./metrics-model";

const TAB_OPTIONS = TABS.map((value) => ({ value, label: metricsCopy.tabs[value] }));

const BASELINE_COLUMNS: readonly Column<BaselineRow>[] = [
  { id: "action", header: metricsCopy.baseline.action, cell: (row) => row.action },
  { id: "count", header: metricsCopy.baseline.count, cell: (row) => formatNumber(row.count), align: "right" },
  { id: "minutes", header: metricsCopy.baseline.minutes, cell: (row) => formatNumber(row.minutes), align: "right" },
];

/** Saves `csv` as a file named by the BFF: a blob of this page, nothing leaves the browser. */
function saveCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function Tile({ card }: { readonly card: KpiCard }) {
  const hint = (
    <>
      <span className="block">{card.hint}</span>
      {card.notes.map((note) => (
        <span key={note} className="mt-0.5 block">
          {note}
        </span>
      ))}
    </>
  );
  return <StatTile label={card.title} value={card.valueText} tone={card.tone} hint={hint} />;
}

function BaselineSection({ baseline }: { readonly baseline: Baseline }) {
  const copy = metricsCopy.baseline;
  const footer = (
    <p className="flex flex-wrap justify-between gap-2 text-sm">
      <span>
        {copy.total}: {metricsCopy.units.minutes(formatNumber(baseline.totalMinutes, 1))} · {copy.label}
      </span>
      {baseline.basis ? <span className="text-slate">{copy.basis(baseline.basis)}</span> : null}
    </p>
  );
  return (
    <Section id="metrics-baseline" title={copy.title} description={copy.description}>
      <Table columns={BASELINE_COLUMNS} rows={baseline.rows} keyOf={(row) => row.action} emptyTitle={copy.label} caption={copy.title} variant="inset" />
      <div className="mt-3">{footer}</div>
    </Section>
  );
}

function TabBody({ summary }: { readonly summary: MetricsSummary }) {
  const baseline = baselineOf(summary);
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm font-semibold text-navy">{summaryLine(summary)}</p>
      <StatGrid>
        {kpiCards(summary).map((card) => (
          <Tile key={card.key} card={card} />
        ))}
      </StatGrid>
      {baseline ? <BaselineSection baseline={baseline} /> : null}
      {summary.tab === "WORLD" ? (
        <Section id="metrics-by-rule" title={metricsCopy.byRule.title} description={metricsCopy.byRule.description}>
          <RuleCountsTable byRule={decisionsByRuleOf(summary)} />
        </Section>
      ) : null}
    </div>
  );
}

export default function View() {
  const { trpc } = useSession();
  const [tab, setTab] = useState<KpiTabValue>("WORLD");
  const summary = useLiveRemote(`metrics.summary:${tab}`, (signal) => trpc.metrics.summary.query({ tab }, { signal }));
  const exporter = useAction(async (current: KpiTabValue) => {
    const file = await trpc.metrics.export.query({ tab: current });
    saveCsv(file.filename, file.csv);
    return file.filename;
  });
  const view = consoleCopy.views.metrics;

  return (
    <div>
      <PageHeader
        title={view.title}
        description={view.description}
        actions={
          <Button variant="secondary" disabled={exporter.state.status === "running"} onClick={() => void exporter.run(tab)}>
            {metricsCopy.export.button}
          </Button>
        }
      />
      <div className="mb-4 flex flex-col gap-2">
        <FilterPills label={metricsCopy.tabs.label} options={TAB_OPTIONS} value={tab} onChange={setTab} />
        <p className="text-sm text-slate">{metricsCopy.tabLead[tab]}</p>
      </div>
      <div className="mb-4">
        <ActionOutcome state={exporter.state} done={metricsCopy.export.done} />
      </div>
      <RemoteBlock state={summary.state} onRetry={summary.reload}>
        {(data) => <TabBody summary={data} />}
      </RemoteBlock>
    </div>
  );
}
