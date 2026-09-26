// Reloj de demo (`/app/clock`, docs/design-brief.md §6, FL-065 and FL-087): the simulated hour and
// mode of the user's world, its next events of every kind, and the controls that move it: advance to
// an hour or to one of those events, the live clock, the events of an operation (ETA, milestone,
// dispatch status) and "Reiniciar demo". The world's state comes from the shell's own poll of
// `clock.get` (every 3 s while busy, 15 s at rest); while the world is busy every control that moves
// time is closed with what it waits for, and after five real minutes it offers to go ahead anyway.
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { PageHeader } from "../../components/PageHeader";
import { LoadingBlock, RemoteBlock } from "../../components/RemoteBlock";
import { StatGrid, StatTile } from "../../components/StatTile";
import { useSession } from "../../context/SessionContext";
import { useLiveRemote, useWorldClock } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import { formatSimDateTime } from "../../lib/format";
import { type ClockDetail, clockDetailOf } from "./clock-api";
import { controlGate, modeText } from "./clock-model";
import { clockCopy } from "./copy";
import { EventsSection } from "./EventsSection";
import { MoveSection } from "./MoveSection";
import { OperationSection } from "./OperationSection";
import { ResetSection } from "./ResetSection";

function NowTiles({ detail }: { readonly detail: ClockDetail }) {
  const copy = clockCopy.now;
  return (
    <section aria-label={copy.title} className="mb-6">
      <StatGrid>
        <StatTile label={copy.simNow} value={<time dateTime={detail.simNow}>{formatSimDateTime(detail.simNow)}</time>} tone="brand" />
        <StatTile label={copy.mode} value={modeText(detail)} />
        {detail.startAtSim ? <StatTile label={copy.start} value={formatSimDateTime(detail.startAtSim)} /> : null}
        {detail.worldEpoch ? <StatTile label={copy.epoch} value={detail.worldEpoch} hint={copy.epochHint} /> : null}
      </StatGrid>
    </section>
  );
}

export default function View() {
  const { trpc } = useSession();
  const { snapshot, error, refresh } = useWorldClock();
  const operations = useLiveRemote("clock:operations", (signal) => trpc.operations.list.query({}, { signal }));
  const detail = clockDetailOf(snapshot);
  const gate = controlGate(snapshot, Date.now());
  const view = consoleCopy.views.clock;

  let body;
  if (detail === undefined) body = error ? <ApiErrorNotice error={error} onRetry={refresh} /> : <LoadingBlock />;
  else {
    body = (
      <div className="flex flex-col gap-6">
        <NowTiles detail={detail} />
        <MoveSection detail={detail} gate={gate} />
        <EventsSection detail={detail} gate={gate} />
        <RemoteBlock state={operations.state} onRetry={operations.reload}>
          {(data) => <OperationSection operations={data.operations} gate={gate} />}
        </RemoteBlock>
        <ResetSection detail={detail} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={view.title} description={view.description} />
      {body}
    </div>
  );
}
