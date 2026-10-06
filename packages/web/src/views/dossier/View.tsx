// Detalle del legajo (docs/design-brief.md §6, row 2; FL-081 and the firm's actions of FL-042..FL-044,
// FL-067, FL-068, FL-073, FL-075): the summary with ETA, risk and parties, the three documents with
// versions, readings and observations, the pendings with their reason and "Avanzar hasta ahí", and the
// unified timeline in simulated order. The operation id comes from the route and is validated before
// any call; another firm's id is refused by the BFF (403) and nothing of it is shown (FL-082). The
// view follows the world at the shell's cadence.
import { OperationId } from "@legajo/shared";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { SectionNav } from "../../components/Section";
import { useSession } from "../../context/SessionContext";
import { useLiveRemote, useWorldClock } from "../../context/WorldClockContext";
import { copy } from "../../copy/console";
import { Link, useRouter } from "../../lib/router";
import { CONSOLE_HOME, routeOf } from "../../routes";
import { type DossierBundle, fetchDossier } from "./api";
import { dossierCopy } from "./copy";
import { DocumentsSection } from "./DocumentsSection";
import { DossierActions } from "./DossierActions";
import { PendingSection } from "./PendingSection";
import { SummarySection } from "./SummarySection";
import { mergeTimeline } from "./timeline-model";
import { TimelineSection } from "./TimelineSection";

/** Built when the view renders, so the labels follow the console's language. */
const sectionLinks = () => [
  { id: "summary", label: dossierCopy.sections.summary },
  { id: "documents", label: dossierCopy.sections.documents },
  { id: "pending", label: dossierCopy.sections.pending },
  { id: "timeline", label: dossierCopy.sections.timeline },
];

function BackLink() {
  return (
    <Link to={CONSOLE_HOME} className="text-sm font-semibold text-cyan-deep underline">
      {dossierCopy.back}
    </Link>
  );
}

function DossierBody({ bundle, onChanged }: { readonly bundle: DossierBundle; readonly onChanged: () => void }) {
  const { snapshot } = useWorldClock();
  const { dossier, timeline, decisions } = bundle;
  const { operation } = dossier;
  // The shell's clock is the session's world; the simulated now of another world is not this one's.
  const simNow = snapshot?.clockId === operation.clockId ? snapshot.simNow : undefined;
  return (
    <div className="space-y-6">
      <p className="text-base font-semibold text-navy">{dossierCopy.heading(operation.operationNumber, dossier.importer.name, dossier.supplier.name)}</p>
      <DossierActions dossier={dossier} entries={timeline.entries} simNow={simNow} onChanged={onChanged} />
      <SectionNav label={dossierCopy.sections.nav} links={sectionLinks()} />
      <SummarySection dossier={dossier} simNow={simNow} />
      <DocumentsSection dossier={dossier} onChanged={onChanged} />
      <PendingSection clockId={operation.clockId} operationNumber={operation.operationNumber} timers={timeline.pending} supplierZone={dossier.supplier.timezone} onChanged={onChanged} />
      <TimelineSection items={mergeTimeline(timeline.entries, decisions)} />
    </div>
  );
}

function Dossier({ operationId }: { readonly operationId: string }) {
  const { trpc } = useSession();
  const remote = useLiveRemote(`dossier:${operationId}`, (signal) => fetchDossier(trpc, operationId, signal));
  return (
    <RemoteBlock state={remote.state} onRetry={remote.reload}>
      {(bundle) => <DossierBody bundle={bundle} onChanged={remote.reload} />}
    </RemoteBlock>
  );
}

export default function View() {
  const { path } = useRouter();
  const parsed = OperationId.safeParse(routeOf(path)?.params.operationId);
  const view = copy.views.dossier;
  return (
    <div>
      <PageHeader title={view.title} description={view.description} actions={<BackLink />} />
      {parsed.success ? <Dossier operationId={parsed.data} /> : <EmptyState title={dossierCopy.notFound.title} lead={dossierCopy.notFound.lead} action={<BackLink />} />}
    </div>
  );
}
