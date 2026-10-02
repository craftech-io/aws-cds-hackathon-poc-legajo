// Documents of the dossier (docs/design-brief.md §6, row 2): per document its state (faltante /
// recibido / con observación / válido), responsible and what made it valid; its versions with who
// sent them, by which channel, the reader's answer and a 5-minute download link; the reader's
// observations with expected and found values, responsible, attempts and the matrix flag (FL-042);
// and the firm's decisions: dispense an observation (FL-043), classify an unknown PDF (FL-044).
import { useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Section } from "../../components/Section";
import { type Column, Table } from "../../components/Table";
import { useSession } from "../../context/SessionContext";
import { formatReaderValue, formatSimDateTime } from "../../lib/format";
import { useAction } from "../../lib/use-remote";
import { fetchDocumentUrl } from "./api";
import { dossierCopy } from "./copy";
import { DocStatusBadge } from "./doc-status";
import { ClassifyDrawer, WaiveDrawer } from "./DocumentDrawers";
import { type DocumentCard, differsFromMatrix, documentCards, isObservationOpen } from "./dossier-model";
import {
  docTypeLabel,
  observationCodeLabel,
  observationStatusLabel,
  observationStatusTone,
  partyLabel,
  readingStatusLabel,
  severityLabel,
  sourceChannelLabel,
  versionStateLabel,
} from "./labels";
import type { DossierData, ObservationData, VersionData } from "./types";

const text = dossierCopy.documents;

function readingText(version: VersionData): string {
  const { reading } = version;
  if (!reading) return versionStateLabel[version.state] ?? "";
  const confidence = reading.confidence === undefined ? "" : ` · ${text.confidence(Math.round(reading.confidence * 100))}`;
  return `${readingStatusLabel[reading.status]}${confidence}`;
}

function versionColumns(onDownload: (version: VersionData) => void, busy: boolean): Column<VersionData>[] {
  return [
    { id: "version", header: text.columns.version, cell: (version) => <span className="font-semibold">{text.version(version.versionNo)}</span> },
    {
      id: "received",
      header: text.columns.received,
      cell: (version) => text.received(formatSimDateTime(version.receivedAtSim), partyLabel[version.source.party].toLowerCase(), sourceChannelLabel[version.source.channel]),
    },
    { id: "state", header: text.columns.state, cell: (version) => versionStateLabel[version.state] ?? "" },
    { id: "reading", header: text.columns.reading, cell: readingText },
    {
      id: "file",
      header: text.columns.file,
      cell: (version) => (
        <Button variant="ghost" disabled={busy} aria-label={text.downloadLabel(docTypeLabel[version.docType], version.versionNo)} onClick={() => onDownload(version)}>
          {text.download}
        </Button>
      ),
    },
  ];
}

function ObservationItem({ observation, onWaive }: { readonly observation: ObservationData; readonly onWaive: (observation: ObservationData) => void }) {
  const label = observationCodeLabel[observation.code];
  return (
    <li className="space-y-1 rounded-md border border-mist px-3 py-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{label}</span>
        <Badge tone={observation.severity === "BLOCKING" ? "danger" : "neutral"}>{severityLabel[observation.severity]}</Badge>
        <Badge tone={observationStatusTone[observation.status]}>{observationStatusLabel[observation.status]}</Badge>
      </p>
      {observation.expected !== undefined && observation.found !== undefined ? <p className="text-slate">{text.expectedFound(formatReaderValue(observation.expected), formatReaderValue(observation.found))}</p> : null}
      <p className="flex flex-wrap items-center gap-2 text-slate">
        <span>
          {text.responsible}: {observation.responsibleParty ? partyLabel[observation.responsibleParty] : text.noResponsible}
        </span>
        <span>· {text.attempts(observation.attempts)}</span>
        {differsFromMatrix(observation) ? <Badge tone="warning">{text.matrixDiffers}</Badge> : null}
      </p>
      {observation.waiveReason ? <p className="text-slate">{text.waivedBecause(observation.waiveReason)}</p> : null}
      {isObservationOpen(observation) ? (
        <Button variant="secondary" aria-label={text.waiveLabel(label)} onClick={() => onWaive(observation)}>
          {text.waive}
        </Button>
      ) : null}
    </li>
  );
}

interface BlockProps {
  readonly card: DocumentCard;
  readonly columns: readonly Column<VersionData>[];
  readonly onWaive: (observation: ObservationData) => void;
  readonly onClassify: (version: VersionData) => void;
}

function DocumentBlock({ card, columns, onWaive, onClassify }: BlockProps) {
  const headingId = `doc-${card.docType}`;
  const responsible = card.document?.responsibleParty;
  const validatedBy = card.document?.validatedBy;
  return (
    <article aria-labelledby={headingId} className="space-y-3 border-t border-mist pt-4 first:border-t-0 first:pt-0">
      <header className="flex flex-wrap items-center gap-3">
        <h3 id={headingId} className="text-base font-semibold text-navy">
          {docTypeLabel[card.docType]}
        </h3>
        <DocStatusBadge status={card.status} />
        <span className="text-sm text-slate">
          {text.responsible}: {responsible ? partyLabel[responsible] : text.noResponsible}
        </span>
        {validatedBy ? <span className="text-sm text-slate">· {text.validatedBy[validatedBy] ?? ""}</span> : null}
      </header>
      {card.unrecognized.map((version) => (
        <Callout
          key={version.docVersionId}
          tone="warning"
          action={
            <Button variant="secondary" onClick={() => onClassify(version)}>
              {text.classify}
            </Button>
          }
        >
          {text.unrecognized(version.versionNo)}
        </Callout>
      ))}
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate">{text.versions}</h4>
      {card.versions.length === 0 ? (
        <p className="text-sm text-slate">{text.noVersions}</p>
      ) : (
        <Table<VersionData> variant="inset" columns={columns} rows={card.versions} keyOf={(version) => version.docVersionId} emptyTitle={text.noVersions} caption={`${text.versions}: ${docTypeLabel[card.docType]}`} />
      )}
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate">{text.observations}</h4>
      {card.observations.length === 0 ? (
        <p className="text-sm text-slate">{text.noObservations}</p>
      ) : (
        <ul className="space-y-2">
          {card.observations.map((observation) => (
            <ObservationItem key={observation.observationId} observation={observation} onWaive={onWaive} />
          ))}
        </ul>
      )}
    </article>
  );
}

interface DocumentsSectionProps {
  readonly dossier: DossierData;
  readonly onChanged: () => void;
}

export function DocumentsSection({ dossier, onChanged }: DocumentsSectionProps) {
  const { trpc } = useSession();
  const [waiving, setWaiving] = useState<ObservationData | undefined>(undefined);
  const [classifying, setClassifying] = useState<VersionData | undefined>(undefined);
  // The link lives 5 minutes and forces a download: the console stays where it is.
  const download = useAction(async (version: VersionData) => {
    const url = await fetchDocumentUrl(trpc, version.docVersionId);
    window.location.assign(url);
    return url;
  });
  const columns = versionColumns((version) => void download.run(version), download.state.status === "running");
  const { operationId } = dossier.operation;

  return (
    <Section id="documents" title={dossierCopy.sections.documents}>
      <div className="space-y-5">
        {documentCards(dossier).map((card) => (
          <DocumentBlock key={card.docType} card={card} columns={columns} onWaive={setWaiving} onClassify={setClassifying} />
        ))}
        {download.state.status === "error" ? <ApiErrorNotice error={download.state.error} /> : null}
      </div>
      {waiving ? <WaiveDrawer operationId={operationId} observation={waiving} onClose={() => setWaiving(undefined)} onDone={onChanged} /> : null}
      {classifying ? <ClassifyDrawer operationId={operationId} version={classifying} onClose={() => setClassifying(undefined)} onDone={onChanged} /> : null}
    </Section>
  );
}
