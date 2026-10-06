// One step of the guided tour in the panel: its buttons (in order; a move that changes the world
// waits for a quiet one), what to look at with the hours read from the world (`tour.steps`), how long to wait, the
// English gloss of the Spanish message it produces, and a link to the view where it shows.
import { Button } from "../../components/Button";
import { TOUR_TEXTS } from "./copy";
import { type TourLang, type TourMove, type TourStep, TOUR_STEPS, formatTourTime, lookText, AR_ZONE } from "./steps";
import { type TourClock, type TourProgress, moveGate, nextEventAt, resolveTourTime } from "./tour-model";

interface StepCardProps {
  readonly step: TourStep;
  readonly lang: TourLang;
  /** The world's `clock.get`: where "Avanzar al próximo evento" lands. */
  readonly clock: TourClock | undefined;
  /** `tour.steps`: every pending timer of 4471, the hours of "Qué mirar". */
  readonly times: TourClock | undefined;
  readonly progress: TourProgress;
  /** The world is known: the progress is kept per world and epoch, so no move is taken before it. */
  readonly ready: boolean;
  readonly busy: boolean;
  readonly running: boolean;
  readonly gloss: string | undefined;
  readonly onMove: (step: TourStep, index: number, move: TourMove) => void;
  readonly onGoTo: (step: TourStep) => void;
}

export function StepCard({ step, lang, clock, times, progress, ready, busy, running, gloss, onMove, onGoTo }: StepCardProps) {
  const texts = TOUR_TEXTS[lang];
  const next = nextEventAt(clock);
  const blockedByBusy = step.moves.some((_, index) => moveGate(step, index, progress, busy) === "busy");
  return (
    <article aria-labelledby={`tour-step-${step.id}`} className="flex flex-col gap-3">
      <p className="text-xs font-semibold tracking-wide text-slate uppercase">{texts.progress(step.number, TOUR_STEPS.length)}</p>
      <h3 id={`tour-step-${step.id}`} className="text-lg font-semibold text-navy">
        {step.title[lang]}
      </h3>
      <div className="flex flex-col gap-2">
        {step.moves.map((move, index) => {
          const gate = moveGate(step, index, progress, busy);
          return (
            <div key={`${step.id}-${index}`} className="flex flex-wrap items-center gap-2">
              <Button variant={gate === "done" ? "secondary" : "primary"} disabled={!ready || running || gate === "busy" || gate === "blocked"} onClick={() => onMove(step, index, move)}>
                {move.label[lang]}
              </Button>
              {gate === "done" ? <span className="text-xs font-semibold text-success">{texts.done}</span> : null}
            </div>
          );
        })}
      </div>
      {blockedByBusy ? (
        <p role="status" className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">
          {texts.busy}
        </p>
      ) : null}
      {step.moves.some((move) => move.action.kind === "advanceToNext") && next ? <p className="text-xs text-slate">{texts.lands(formatTourTime(next, AR_ZONE, lang))}</p> : null}
      <section aria-label={texts.look}>
        <h4 className="text-xs font-semibold tracking-wide text-slate uppercase">{texts.look}</h4>
        <p className="mt-1 text-sm text-ink">{lookText(step, lang, (_name, time) => resolveTourTime(times, time))}</p>
      </section>
      <p className="text-sm">
        <span className="font-semibold text-slate">{texts.wait}:</span> {step.wait[lang]}
      </p>
      {step.glossOf ? (
        <section aria-label={texts.gloss} className="rounded-md bg-paper px-3 py-2">
          <h4 className="text-xs font-semibold tracking-wide text-slate uppercase">{texts.gloss}</h4>
          <p lang="en" className="mt-1 text-sm text-ink italic">
            {gloss ?? texts.glossMissing}
          </p>
        </section>
      ) : null}
      <button type="button" className="inline-flex min-h-11 items-center self-start rounded-md px-2 text-sm font-semibold text-cyan-deep underline hover:bg-paper" onClick={() => onGoTo(step)}>
        {texts.goTo(texts.views[step.view])}
      </button>
    </article>
  );
}
