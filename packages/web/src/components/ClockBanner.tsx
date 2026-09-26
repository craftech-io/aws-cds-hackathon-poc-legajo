// The simulated-time bar every console view carries (docs/design-brief.md §6): "Hora simulada ·
// mié 14/10 10:30 · reloj de demo en pausa" with "Avanzar al próximo evento", "+1 h" and "+1 día".
// While the world is busy (a turn, a queued event, a mail in transit, a PDF scan) the buttons are
// disabled and the bar says what the world waits for and how long it usually takes; after five real
// minutes it offers "Avanzar igual" with its warning. The BFF enforces the same gate (`WORLD_BUSY`).
import { useId } from "react";
import { useWorldClock } from "../context/WorldClockContext";
import { copy } from "../copy/console";
import { formatSimDateTime, formatTime } from "../lib/format";
import { type ClockSnapshot, MINUTES_PER_DAY, MINUTES_PER_HOUR, canForce, isBusy, waitText } from "../lib/world-clock";
import { describeApiError } from "./ApiErrorNotice";
import { Button } from "./Button";

function modeText(snapshot: ClockSnapshot): string {
  if (snapshot.mode === "PAUSED") return copy.clock.paused;
  return copy.clock.running(snapshot.runningUntilReal ? formatTime(snapshot.runningUntilReal) : undefined);
}

function Controls({ snapshot, describedBy }: { readonly snapshot: ClockSnapshot; readonly describedBy: string | undefined }) {
  const { move, moving } = useWorldClock();
  const disabled = moving || isBusy(snapshot);
  const common = { disabled, ...(describedBy !== undefined ? { "aria-describedby": describedBy } : {}) };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button {...common} onClick={() => void move({ kind: "next" })}>
        {copy.clock.next}
      </Button>
      <Button variant="secondary" title={copy.clock.plusHourLabel} {...common} onClick={() => void move({ kind: "by", minutes: MINUTES_PER_HOUR })}>
        {copy.clock.plusHour}
      </Button>
      <Button variant="secondary" title={copy.clock.plusDayLabel} {...common} onClick={() => void move({ kind: "by", minutes: MINUTES_PER_DAY })}>
        {copy.clock.plusDay}
      </Button>
    </div>
  );
}

function ForceRow() {
  const { move, moving } = useWorldClock();
  return (
    <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
      <span>{copy.clock.forceWarning}</span>
      <Button variant="danger" disabled={moving} onClick={() => void move({ kind: "next" }, true)}>
        {copy.clock.force}
      </Button>
    </div>
  );
}

export function ClockBanner() {
  const { snapshot, error, moveError, refresh } = useWorldClock();
  const statusId = useId();

  let body;
  if (!snapshot) {
    body = error ? (
      <p className="flex flex-wrap items-center gap-3 text-sm">
        <span>{copy.clock.unavailable}</span>
        <button type="button" className="font-semibold text-cyan underline" onClick={refresh}>
          {copy.clock.retry}
        </button>
      </p>
    ) : (
      <p className="text-sm text-mist">{copy.clock.loading}</p>
    );
  } else {
    const waiting = waitText(snapshot);
    body = (
      <>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm">
            <span className="font-semibold">{copy.clock.label}</span> · <time dateTime={snapshot.simNow}>{formatSimDateTime(snapshot.simNow)}</time> · {modeText(snapshot)}
          </p>
          <p id={statusId} role="status" className="text-sm text-cyan-soft">
            {waiting ?? ""}
          </p>
          <div className="md:ml-auto">
            <Controls snapshot={snapshot} describedBy={waiting ? statusId : undefined} />
          </div>
        </div>
        {canForce(snapshot, Date.now()) ? <ForceRow /> : null}
      </>
    );
  }

  return (
    <section aria-label={copy.clock.region} className="border-b border-navy-soft bg-navy-deep px-4 py-2.5 text-white md:px-6">
      {body}
      {moveError ? (
        <p role="alert" className="mt-2 text-sm text-warning-soft">
          {moveError.reason === "WORLD_BUSY" ? copy.clock.busyRefused : describeApiError(moveError)}
        </p>
      ) : null}
    </section>
  );
}
