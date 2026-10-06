// The step numbers of the tour ("01 … 08"): one link per step, the current one filled. They stick under
// the header while the visitor reads the steps (`position: sticky`, no script: it is released by the
// browser once the last step has gone by) and sit on the section's own background, so the steps
// scroll beneath them. Colour changes only; nothing moves with reduced motion or paused animations.
import { useLandingCopy } from "./lang";
import { TOUR_STEPS, stepAnchor } from "./tour-steps";

export function TourPills({ active }: { readonly active: number }) {
  const { tour } = useLandingCopy();
  return (
    <nav aria-label={tour.stepsLabel} data-tour-pills="" className="sticky top-16.25 z-20 bg-harbor-950 py-2">
      <ol className="flex gap-1">
        {TOUR_STEPS.map((candidate, index) => (
          <li key={candidate.id} className="min-w-0 max-w-11 flex-1">
            <a
              href={`#${stepAnchor(candidate.id)}`}
              aria-current={index === active ? "step" : undefined}
              className={`flex h-11 w-full items-center justify-center rounded-full font-display text-sm font-semibold ${index === active ? "bg-signal text-harbor-950" : "bg-harbor-900 text-foam-muted hover:text-foam"}`}
            >
              <span className="sr-only">{tour.stepLabel(index + 1, TOUR_STEPS.length)}</span>
              <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
