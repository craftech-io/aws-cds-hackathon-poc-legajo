// "Cómo funciona" (docs/landing-spec.md §1.4 and §4.3): the eight steps of operation 4471 in three
// shapes fed by one array (tour-steps.ts). From 1024 px, the steps on the left and a sticky stage on
// the right whose visual changes with the step in the middle of the screen (one IntersectionObserver;
// a View Transition where it exists, a CSS cross-fade otherwise), with the route line filling as it
// scrolls. From 768 px, stacked cards, visual above text. Below, a swipeable carousel with scroll-snap,
// previous and next buttons and "Paso 3 de 8". Neither the stage nor a carousel step ever cuts or
// scrolls its visual: FitToSlot scales it to the stage's box (centred) or to 56 % of the viewport's
// height. With reduced motion or paused animations the visual cuts straight to the next step and every
// sequence is in its final state.
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { SectionShell } from "../../components/Section";
import { Icon } from "./icons";
import { useLandingCopy } from "./lang";
import { useInView, useMediaQuery } from "./motion/hooks";
import { useMotion } from "./motion/MotionContext";
import { TOUR_STEPS, type TourStep, clampStep, routeProgress, stepAnchor } from "./tour-steps";
import { FitToSlot } from "./FitToSlot";
import { StepText, VisualFooter } from "./TourParts";
import { StepVisual } from "./TourVisuals";

type ViewTransitionDocument = Document & { startViewTransition?: (callback: () => void) => { readonly ready: Promise<void>; readonly finished: Promise<void> } };

/** Share of the viewport's height a carousel step's visual may take (docs/landing-spec.md §4.3). */
const CAROUSEL_VISUAL_SHARE = { viewportShare: 0.56 } as const;

/** Which step's article sits in the middle band of `root` (the viewport, or the carousel). */
function useActiveStep(items: RefObject<(HTMLElement | null)[]>, options: IntersectionObserverInit, enabled = true): number {
  const [active, setActive] = useState(0);
  const { animate } = useMotion();
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      const last = visible[visible.length - 1];
      if (!last) return;
      const index = Number((last.target as HTMLElement).dataset.step);
      const change = () => setActive(index);
      const start = (document as ViewTransitionDocument).startViewTransition;
      if (!animate || typeof start !== "function") {
        change();
        return;
      }
      // A newer step skips the transition in flight: that is expected, not an error.
      const transition = start.call(document, () => flushSync(change));
      transition.ready.catch(() => undefined);
      transition.finished.catch(() => undefined);
    }, options);
    for (const element of items.current ?? []) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [items, options, enabled, animate]);
  return active;
}

const MIDDLE_BAND: IntersectionObserverInit = { rootMargin: "-45% 0px -45% 0px" };

/** View Transitions swap the stage's visual; without them it enters with a CSS animation. */
function hasViewTransitions(): boolean {
  return typeof document !== "undefined" && "startViewTransition" in document;
}

function StickyTour() {
  const { tour } = useLandingCopy();
  const { animate } = useMotion();
  const articles = useRef<(HTMLElement | null)[]>([]);
  const active = useActiveStep(articles, MIDDLE_BAND);
  const step = TOUR_STEPS[active] ?? TOUR_STEPS[0];
  if (!step) return null;
  return (
    <div className="grid grid-cols-12 gap-10">
      <div className="col-span-5">
        <nav aria-label={tour.stepsLabel}>
          <ol className="flex flex-wrap gap-1">
            {TOUR_STEPS.map((candidate, index) => (
              <li key={candidate.id}>
                <a href={`#${stepAnchor(candidate.id)}`} aria-current={index === active ? "step" : undefined} className={`flex h-11 w-11 items-center justify-center rounded-full font-display text-sm font-semibold ${index === active ? "bg-signal text-harbor-950" : "text-foam-muted hover:text-foam"}`}>
                  <span className="sr-only">{tour.stepLabel(index + 1, TOUR_STEPS.length)}</span>
                  <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="tour-steps relative mt-6 pl-10">
          <span aria-hidden="true" className="route-dots absolute bottom-0 left-3 top-0 w-0.5" />
          <span
            aria-hidden="true"
            data-route-progress=""
            style={{ ["--route" as string]: animate ? routeProgress(active) : 1 }}
            className="absolute bottom-0 left-3 top-0 w-0.5 origin-top bg-signal [transform:scaleY(var(--route))] transition-transform duration-500 ease-out"
          />
          {TOUR_STEPS.map((candidate, index) => (
            <article
              key={candidate.id}
              id={stepAnchor(candidate.id)}
              ref={(element) => {
                articles.current[index] = element;
              }}
              data-step={index}
              aria-labelledby={`${stepAnchor(candidate.id)}-title`}
              aria-current={index === active ? "step" : undefined}
              className="flex min-h-[72vh] scroll-mt-24 items-center"
            >
              <StepText step={candidate} index={index} headingId={`${stepAnchor(candidate.id)}-title`} active={index === active} />
            </article>
          ))}
        </div>
      </div>
      <div className="col-span-7">
        <div className="sticky top-[calc(var(--header-h,4.5rem)+2rem)] flex h-[min(80vh,44rem)] flex-col rounded-panel border border-harbor-700 bg-harbor-900/60 p-5 shadow-float">
          <p aria-live="polite" className="sr-only">
            {tour.steps[step.id].title}
          </p>
          <div
            data-tour-stage=""
            key={hasViewTransitions() ? "stage" : step.id}
            role="group"
            aria-label={tour.steps[step.id].title}
            className={`min-h-0 flex-1 overflow-hidden ${animate && !hasViewTransitions() ? "animate-stage-in" : ""}`}
          >
            <FitToSlot key={step.id} limit="box">
              <StepVisual id={step.id} play={animate} />
            </FitToSlot>
          </div>
          <VisualFooter step={step} />
        </div>
      </div>
    </div>
  );
}

function StackedStep({ step, index }: { readonly step: TourStep; readonly index: number }) {
  const { animate } = useMotion();
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref, { threshold: 0.5, once: true });
  return (
    <article ref={ref} id={stepAnchor(step.id)} aria-labelledby={`${stepAnchor(step.id)}-title`} className="rounded-panel border border-harbor-700 bg-harbor-900/60 p-6">
      <div data-reveal="">
        <div data-step-visual={step.id}>
          <StepVisual id={step.id} play={animate && seen} />
        </div>
        <VisualFooter step={step} />
      </div>
      <div className="mt-6">
        <StepText step={step} index={index} headingId={`${stepAnchor(step.id)}-title`} />
      </div>
    </article>
  );
}

const CAROUSEL_BAND: IntersectionObserverInit = { threshold: 0.6 };

function CarouselTour() {
  const { tour } = useLandingCopy();
  const { animate } = useMotion();
  const scroller = useRef<HTMLDivElement>(null);
  const articles = useRef<(HTMLElement | null)[]>([]);
  const [options, setOptions] = useState<IntersectionObserverInit | undefined>(undefined);
  useEffect(() => setOptions({ ...CAROUSEL_BAND, root: scroller.current }), []);
  const active = useActiveStep(articles, options ?? CAROUSEL_BAND, options !== undefined);

  const go = (index: number) => {
    const target = articles.current[index];
    const box = scroller.current;
    if (!target || !box) return;
    box.scrollTo({ left: target.offsetLeft - box.offsetLeft, behavior: animate ? "smooth" : "auto" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    go(clampStep(active, event.key === "ArrowRight" ? 1 : -1));
  };

  return (
    <div>
      <div
        ref={scroller}
        role="region"
        aria-roledescription={tour.carousel}
        aria-label={tour.stepsLabel}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="relative flex max-w-full snap-x snap-mandatory items-start gap-4 overflow-x-auto overscroll-x-contain pb-2 [scrollbar-width:none]"
      >
        {TOUR_STEPS.map((step, index) => (
          <article
            key={step.id}
            id={stepAnchor(step.id)}
            ref={(element) => {
              articles.current[index] = element;
            }}
            data-step={index}
            aria-labelledby={`${stepAnchor(step.id)}-title`}
            className="w-full shrink-0 snap-center"
          >
            <div role="group" aria-label={tour.steps[step.id].title} className="pt-1">
              <FitToSlot limit={CAROUSEL_VISUAL_SHARE}>
                <StepVisual id={step.id} play={animate && index === active} compact />
              </FitToSlot>
            </div>
            <VisualFooter step={step} />
            <div className="mt-4">
              <StepText step={step} index={index} headingId={`${stepAnchor(step.id)}-title`} />
            </div>
          </article>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <button type="button" aria-label={tour.previous} disabled={active === 0} onClick={() => go(clampStep(active, -1))} className="flex h-11 w-11 items-center justify-center rounded-full border border-harbor-700 text-foam disabled:opacity-40">
          <Icon name="chevronLeft" />
        </button>
        <div className="flex flex-col items-center gap-2">
          <p aria-live="polite" className="text-sm font-semibold text-foam">
            {tour.stepLabel(active + 1, TOUR_STEPS.length)}
          </p>
          <span aria-hidden="true" className="flex gap-1.5">
            {TOUR_STEPS.map((step, index) => (
              <span key={step.id} className={`h-1.5 w-1.5 rounded-full ${index === active ? "bg-signal" : "bg-harbor-700"}`} />
            ))}
          </span>
        </div>
        <button type="button" aria-label={tour.next} disabled={active === TOUR_STEPS.length - 1} onClick={() => go(clampStep(active, 1))} className="flex h-11 w-11 items-center justify-center rounded-full border border-harbor-700 text-foam disabled:opacity-40">
          <Icon name="chevronRight" />
        </button>
      </div>
    </div>
  );
}

export function TourSection() {
  const { tour } = useLandingCopy();
  const desktop = useMediaQuery("(min-width: 1024px)");
  const tablet = useMediaQuery("(min-width: 768px)");
  return (
    <SectionShell id="tour" eyebrow={tour.eyebrow} title={tour.title} lead={tour.lead} tone="dark" wide>
      {desktop ? (
        <StickyTour />
      ) : tablet ? (
        <div className="flex flex-col gap-6">
          {TOUR_STEPS.map((step, index) => (
            <StackedStep key={step.id} step={step} index={index} />
          ))}
        </div>
      ) : (
        <CarouselTour />
      )}
    </SectionShell>
  );
}
