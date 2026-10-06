// Operaciones (docs/design-brief.md §6, row 1; FL-080, FL-005): every operation of the user's world
// with its ETA and time to arrival on the simulated clock, the dossier and its three documents, who
// has the conversation, the next event, open escalations and risk; the 4471 pinned on top as the main
// story; filters by status, risk and ETA range; a row opens the dossier; "Nueva operación" brings one
// from the customs platform. The table follows the world at the shell's cadence (every 3 or 15 s).
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { FilterPills, type PillOption } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { ScopeBar } from "../../components/ScopeBar";
import { useFirm } from "../../context/FirmContext";
import { useSession } from "../../context/SessionContext";
import { useLiveRemote, useWorldClock } from "../../context/WorldClockContext";
import { copy } from "../../copy/console";
import { useRouter } from "../../lib/router";
import { dossierPath } from "../../routes";
import type { OperationsList } from "../dossier/types";
import { fetchOperations } from "./api";
import { operationColumns } from "./columns";
import { operationsCopy } from "./copy";
import { NewOperationDrawer } from "./NewOperationDrawer";
import {
  type ListFilters,
  type ListRow,
  RISK_FILTERS,
  type RiskFilter,
  STATUS_FILTERS,
  type StatusFilter,
  applyFilters,
  listRows,
  riskCounts,
  statusCounts,
  upcomingOf,
} from "./operations-model";

function statusOptions(counts: Readonly<Record<StatusFilter, number>>): PillOption<StatusFilter>[] {
  return STATUS_FILTERS.map((value) => ({ value, label: value === "ALL" ? operationsCopy.filters.all : operationsCopy.filters.statuses[value], count: counts[value] }));
}

function riskOptions(counts: Readonly<Record<RiskFilter, number>>): PillOption<RiskFilter>[] {
  return RISK_FILTERS.map((value) => ({ value, label: value === "ALL" ? operationsCopy.filters.all : operationsCopy.filters.risks[value], count: counts[value] }));
}

// The group already carries the same name for assistive technology; the visible title is for the eye.
function FilterGroup({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p aria-hidden="true" className="text-xs font-semibold uppercase tracking-wide text-slate">
        {title}
      </p>
      {children}
    </div>
  );
}

interface TableProps {
  readonly data: OperationsList;
  readonly filters: ListFilters;
  readonly onStatus: (value: StatusFilter) => void;
  readonly onRisk: (value: RiskFilter) => void;
}

function OperationsTable({ data, filters, onStatus, onRisk }: TableProps) {
  const { snapshot } = useWorldClock();
  const { navigate } = useRouter();
  // The clock of the shell is the world of the session; a list of another world ignores it.
  const sameWorld = snapshot?.clockId === data.clockId;
  const rows = useMemo(
    () => listRows(data.operations, sameWorld ? snapshot?.simNow : undefined, sameWorld ? upcomingOf(snapshot) : undefined),
    [data.operations, sameWorld, snapshot],
  );
  if (rows.length === 0) return <EmptyState title={operationsCopy.empty.title} lead={operationsCopy.empty.lead} />;

  const visible = applyFilters(rows, filters);
  const main = visible.find((row) => row.mainStory);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
        <FilterGroup title={operationsCopy.filters.status}>
          <FilterPills label={operationsCopy.filters.status} options={statusOptions(statusCounts(rows, filters))} value={filters.status} onChange={onStatus} />
        </FilterGroup>
        <FilterGroup title={operationsCopy.filters.risk}>
          <FilterPills label={operationsCopy.filters.risk} options={riskOptions(riskCounts(rows, filters))} value={filters.risk} onChange={onRisk} />
        </FilterGroup>
      </div>
      <p className="text-xs text-slate">{operationsCopy.riskHint}</p>
      <DataTable<ListRow>
        columns={operationColumns()}
        rows={visible}
        keyOf={(row) => row.row.operationId}
        caption={operationsCopy.caption}
        emptyTitle={operationsCopy.emptyFiltered.title}
        emptyLead={operationsCopy.emptyFiltered.lead}
        onRowClick={(row) => navigate(dossierPath(row.row.operationId))}
        {...(main ? { activeKey: main.row.operationId } : {})}
      />
    </div>
  );
}

export default function View() {
  const { trpc } = useSession();
  const { etaRange } = useFirm();
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [risk, setRisk] = useState<RiskFilter>("ALL");
  const [creating, setCreating] = useState(false);
  const remote = useLiveRemote("operations.list", (signal) => fetchOperations(trpc, signal));
  const view = copy.views.operations;

  return (
    <div>
      <PageHeader title={view.title} description={view.description} actions={<Button onClick={() => setCreating(true)}>{operationsCopy.create.open}</Button>} />
      <ScopeBar etaRange />
      <p className="-mt-3 mb-4 text-xs text-slate">{operationsCopy.fictitious}</p>
      <RemoteBlock state={remote.state} onRetry={remote.reload}>
        {(data) => <OperationsTable data={data} filters={{ status, risk, eta: etaRange }} onStatus={setStatus} onRisk={setRisk} />}
      </RemoteBlock>
      {creating ? <NewOperationDrawer open onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
