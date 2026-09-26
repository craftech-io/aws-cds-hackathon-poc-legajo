// Columns of the operations table (docs/design-brief.md §6, row 1): number with the main story and
// the second-act stories named, the parties, ETA and time to arrival on the simulated clock, the
// dossier, its three documents, who has the conversation, the next event, open escalations and risk.
import type { MouseEvent } from "react";
import { Badge } from "../../components/Badge";
import type { Column } from "../../components/Table";
import { formatSimDateTime } from "../../lib/format";
import { Link } from "../../lib/router";
import { dossierPath } from "../../routes";
import { DocStatusStrip } from "../dossier/doc-status";
import { controlLabel, dossierStatusLabel, dossierStatusTone, riskLabel, riskTone, timerTitle } from "../dossier/labels";
import { operationsCopy } from "./copy";
import type { ListRow, NextEventCell } from "./operations-model";

// The link opens the dossier itself: the row's own click must not run a second navigation.
const stop = (event: MouseEvent) => event.stopPropagation();

function OperationCell({ item }: { readonly item: ListRow }) {
  const { row } = item;
  return (
    <div className="space-y-1">
      <span onClick={stop}>
        <Link to={dossierPath(row.operationId)} className="relative inline-block text-base font-semibold text-navy underline-offset-2 hover:underline">
          <span className="sr-only">{operationsCopy.openDossier(row.operationNumber)}: </span>
          {row.operationNumber}
        </Link>
      </span>
      {item.mainStory ? (
        <p className="whitespace-nowrap">
          <Badge tone="info">{operationsCopy.mainStory}</Badge>
        </p>
      ) : null}
      {item.secondAct ? <p className="text-xs text-slate">{operationsCopy.secondAct[item.secondAct]}</p> : null}
      <p className="text-xs text-slate">{operationsCopy.vessel(row.vessel)}</p>
    </div>
  );
}

function NextEvent({ cell }: { readonly cell: NextEventCell }) {
  switch (cell.kind) {
    case "event":
      return (
        <span className="flex flex-col">
          <time dateTime={cell.event.dueAtSim} className="whitespace-nowrap font-medium text-ink">
            {formatSimDateTime(cell.event.dueAtSim)}
          </time>
          <span className="text-xs text-slate">{timerTitle(cell.event.kind, cell.event.timerId)}</span>
        </span>
      );
    case "later":
      return <span className="text-slate">{operationsCopy.next.later(formatSimDateTime(cell.after))}</span>;
    case "none":
      return <span className="text-slate">{operationsCopy.next.none}</span>;
    case "unknown":
      return <span className="text-slate">{operationsCopy.unknown}</span>;
  }
}

/** Time to arrival on the simulated clock, with the risk it carries. */
function ArrivalCell({ item }: { readonly item: ListRow }) {
  const { toEta, risk } = item;
  return (
    <span className="flex flex-col items-start gap-1 whitespace-nowrap">
      <span>{toEta ? (toEta.arrived ? operationsCopy.arrived : operationsCopy.toArrival(toEta.days, toEta.hours)) : operationsCopy.unknown}</span>
      {risk ? <Badge tone={riskTone[risk]}>{riskLabel[risk]}</Badge> : null}
    </span>
  );
}

/** The dossier's state, its open escalations and the "con error de proceso" flag. */
function DossierCell({ row }: { readonly row: ListRow["row"] }) {
  return (
    <span className="flex flex-col items-start gap-1 whitespace-nowrap">
      <Badge tone={dossierStatusTone[row.dossierStatus]}>{dossierStatusLabel[row.dossierStatus]}</Badge>
      {row.openEscalations > 0 ? <Badge tone="warning">{operationsCopy.escalationsOpen(row.openEscalations)}</Badge> : null}
      {row.processError ? <Badge tone="danger">{operationsCopy.processError}</Badge> : null}
    </span>
  );
}

export const OPERATION_COLUMNS: readonly Column<ListRow>[] = [
  { id: "operation", header: operationsCopy.columns.operation, cell: (item) => <OperationCell item={item} /> },
  {
    id: "parties",
    header: operationsCopy.columns.parties,
    cell: ({ row }) => (
      <span className="flex min-w-44 flex-col">
        <span className="font-medium text-ink">{row.importerName ?? operationsCopy.unknown}</span>
        <span className="text-xs text-slate">{row.supplierName ?? operationsCopy.unknown}</span>
      </span>
    ),
  },
  {
    id: "eta",
    header: operationsCopy.columns.eta,
    cell: ({ row }) => (
      <time dateTime={row.eta} className="whitespace-nowrap">
        {formatSimDateTime(row.eta)}
      </time>
    ),
  },
  { id: "toArrival", header: operationsCopy.columns.toArrival, cell: (item) => <ArrivalCell item={item} /> },
  { id: "dossier", header: operationsCopy.columns.dossier, cell: ({ row }) => <DossierCell row={row} /> },
  { id: "documents", header: operationsCopy.columns.documents, cell: ({ row }) => <DocStatusStrip documents={row.documents} /> },
  { id: "control", header: operationsCopy.columns.control, cell: ({ row }) => controlLabel[row.control] },
  { id: "next", header: operationsCopy.columns.next, cell: ({ next }) => <NextEvent cell={next} /> },
];
