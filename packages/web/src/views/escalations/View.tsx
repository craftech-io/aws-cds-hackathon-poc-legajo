// Escalamientos (docs/design-brief.md §6, row 3): the inbox of what the agent or the deterministic code
// handed to the firm, by reason (§5.8), oldest first, with how long each has been open on the world's
// simulated clock. A row opens the escalation: take the conversation, look at the dossier, resolve it.
// The inbox follows the world at the shell's cadence.
import { useState } from "react";
import { Badge } from "../../components/Badge";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { FilterPills } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import type { Column } from "../../components/Table";
import { useSession } from "../../context/SessionContext";
import { useLiveRemote, useWorldClock } from "../../context/WorldClockContext";
import { copy } from "../../copy/console";
import { formatSimDateTime } from "../../lib/format";
import { actorLabel, escalationReasonLabel } from "../dossier/labels";
import type { EscalationsList } from "../dossier/types";
import { fetchEscalations } from "./api";
import { escalationsCopy } from "./copy";
import { EscalationDrawer } from "./EscalationDrawer";
import { type EscalationRow, type ReasonFilter, byAge, effectiveReason, filterByReason, openFor, reasonCounts } from "./escalations-model";

function columns(simNow: string | undefined): Column<EscalationRow>[] {
  return [
    { id: "operation", header: escalationsCopy.columns.operation, cell: (row) => <span className="font-semibold text-navy">{row.operationNumber}</span> },
    { id: "reason", header: escalationsCopy.columns.reason, cell: (row) => <Badge tone="warning">{escalationReasonLabel[row.reason]}</Badge> },
    { id: "summary", header: escalationsCopy.columns.summary, cell: (row) => <span className="line-clamp-2 max-w-md text-ink">{row.summary}</span> },
    {
      id: "opened",
      header: escalationsCopy.columns.opened,
      cell: (row) => {
        const age = openFor(row.openedAtSim, simNow);
        return (
          <span className="flex flex-col whitespace-nowrap">
            <time dateTime={row.openedAtSim}>{formatSimDateTime(row.openedAtSim)}</time>
            {age ? <span className="text-xs text-slate">{escalationsCopy.openFor(age.days, age.hours)}</span> : null}
          </span>
        );
      },
    },
    { id: "by", header: escalationsCopy.columns.by, cell: (row) => actorLabel(row.openedBy) },
  ];
}

interface InboxProps {
  readonly data: EscalationsList;
  readonly onOpen: (row: EscalationRow) => void;
  readonly selected: EscalationRow | undefined;
}

function Inbox({ data, onOpen, selected }: InboxProps) {
  const { snapshot } = useWorldClock();
  const [reason, setReason] = useState<ReasonFilter>("ALL");
  const rows = byAge(data.escalations);
  if (rows.length === 0) return <EmptyState title={escalationsCopy.empty.title} lead={escalationsCopy.empty.lead} />;

  const shown = effectiveReason(rows, reason);
  const simNow = snapshot?.clockId === data.clockId ? snapshot.simNow : undefined;
  const options = reasonCounts(rows).map(({ reason: value, count }) => ({ value, count, label: value === "ALL" ? escalationsCopy.all : escalationReasonLabel[value] }));
  return (
    <div className="space-y-4">
      <FilterPills label={escalationsCopy.filter} options={options} value={shown} onChange={setReason} />
      <DataTable<EscalationRow>
        columns={columns(simNow)}
        rows={filterByReason(rows, shown)}
        keyOf={(row) => row.escalationId}
        caption={escalationsCopy.caption}
        emptyTitle={escalationsCopy.emptyFiltered}
        onRowClick={onOpen}
        {...(selected ? { activeKey: selected.escalationId } : {})}
      />
    </div>
  );
}

export default function View() {
  const { trpc } = useSession();
  const remote = useLiveRemote("escalations.list", (signal) => fetchEscalations(trpc, signal));
  const [selected, setSelected] = useState<EscalationRow | undefined>(undefined);
  const view = copy.views.escalations;
  return (
    <div>
      <PageHeader title={view.title} description={view.description} />
      <RemoteBlock state={remote.state} onRetry={remote.reload}>
        {(data) => <Inbox data={data} onOpen={setSelected} selected={selected} />}
      </RemoteBlock>
      {selected ? <EscalationDrawer key={selected.escalationId} escalation={selected} onClose={() => setSelected(undefined)} onResolved={remote.reload} /> : null}
    </div>
  );
}
