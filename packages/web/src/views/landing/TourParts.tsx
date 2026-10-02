// Pieces every shape of the tour shares (docs/landing-spec.md §4.3): the text of a step (its number,
// channel, title, simulated time and story), the render label, the English gloss toggle of a step that
// shows the importer's phone, and the "Ampliar" button that opens the console capture of the step (or
// the render's frame while the capture does not exist).
import { useGallery } from "./gallery";
import { GlossToggle } from "./gloss";
import { Icon } from "./icons";
import { useLandingCopy } from "./lang";
import type { TourStep } from "./tour-steps";
import { TOUR_STEPS } from "./tour-steps";

/**
 * The text of a step. Outside the active step (sticky tour) it steps back by colour, never by opacity:
 * dimmed text would fall under the AA contrast the page keeps everywhere.
 */
export function StepText({ step, index, headingId, active = true }: { readonly step: TourStep; readonly index: number; readonly headingId: string; readonly active?: boolean }) {
  const { tour } = useLandingCopy();
  const text = tour.steps[step.id];
  return (
    <div className="flex flex-col gap-3">
      <p className={`font-display text-eyebrow font-semibold uppercase transition-colors duration-500 ${active ? "text-signal" : "text-foam-muted"}`}>
        {tour.stepLabel(index + 1, TOUR_STEPS.length)} · {text.channel}
      </p>
      <h3 id={headingId} className={`font-display text-h3 font-semibold transition-colors duration-500 ${active ? "text-foam" : "text-foam-muted"}`}>
        {text.title}
      </h3>
      <p className="inline-flex w-fit items-center gap-1.5 rounded-pill border border-harbor-700 px-2.5 py-1 text-xs font-semibold text-foam-muted">
        <Icon name="clock" className="h-3.5 w-3.5" />
        {tour.simTime} · {step.when}
      </p>
      <p className="max-w-prose text-base leading-relaxed text-foam-muted">{text.text}</p>
    </div>
  );
}

/** The render's label and "Ampliar" under a visual of the tour. */
export function VisualFooter({ step }: { readonly step: TourStep }) {
  const { tour, media } = useLandingCopy();
  const gallery = useGallery();
  const canZoom = gallery?.canOpen(step.render, step.capture) ?? false;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-foam-muted">
      <span className="inline-flex items-center gap-1.5">
        <Icon name="route" className="h-3.5 w-3.5 text-glass" />
        {tour.renderBadge}
      </span>
      <span className="inline-flex flex-wrap items-center gap-2">
        {step.phone ? <GlossToggle /> : null}
        {canZoom ? (
          <button
            type="button"
            onClick={() => gallery?.open(step.render, step.capture)}
            aria-label={`${tour.enlarge}: ${media.items[step.capture].alt}`}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-harbor-700 px-3 font-semibold text-foam hover:border-foam-muted"
          >
            <Icon name="enlarge" className="h-4 w-4" />
            {tour.enlarge}
          </button>
        ) : null}
      </span>
    </div>
  );
}
