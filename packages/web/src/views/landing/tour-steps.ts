// The eight steps of the product tour (docs/landing-spec.md §1.4), the story of operation 4471 in the
// order a prospect follows it. One array feeds the three shapes of the tour (sticky stage from 1024 px,
// stacked cards from 768 px, carousel below) and names, for each step, the live render the landing
// draws and the console capture that shows the same moment ("Ampliar" opens it once it exists).
import type { ConsoleCaptureId, RenderId } from "./manifest";

export const TOUR_STEP_IDS = ["request", "delegate", "supplier", "reader", "owner", "eta", "escalation", "approval"] as const;
export type TourStepId = (typeof TOUR_STEP_IDS)[number];

export interface TourStep {
  readonly id: TourStepId;
  /** Live component of the step (manifest status `render`). */
  readonly render: RenderId;
  /** Console capture that replaces it, or that "Ampliar" opens (the render's `replacedBy`). */
  readonly capture: ConsoleCaptureId;
  /** A second capture "Ampliar" can walk to (the escalation email the firm receives). */
  readonly alsoCapture?: ConsoleCaptureId;
  /** Simulated time in Argentina when the step happens. */
  readonly when: string;
  /** The visual draws the importer's phone: the step's footer carries the English gloss toggle. */
  readonly phone: boolean;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: "request", render: "tour-request", capture: "console-simulator", when: "15/10 10:00", phone: true },
  { id: "delegate", render: "tour-delegate", capture: "console-simulator", when: "15/10 10:00", phone: true },
  { id: "supplier", render: "tour-supplier", capture: "console-mailbox", when: "15/10 22:00", phone: false },
  { id: "reader", render: "tour-reader", capture: "console-dossier-reading", when: "15/10 22:10", phone: false },
  { id: "owner", render: "tour-owner", capture: "console-dossier", when: "16/10 09:00", phone: true },
  { id: "eta", render: "tour-eta", capture: "console-clock", when: "16/10 10:00", phone: true },
  { id: "escalation", render: "tour-escalation", capture: "console-escalations", alsoCapture: "console-mailbox-firm", when: "16/10 10:24", phone: true },
  { id: "approval", render: "tour-approval", capture: "console-dossier-approval", when: "16/10 11:00", phone: true },
];

/** The hero's conversation: a render of the WhatsApp channel, kept by design ("Ampliar" opens the simulator). */
export const HERO_VISUAL = { render: "hero-conversation", capture: "console-simulator" } as const satisfies { readonly render: RenderId; readonly capture: ConsoleCaptureId };

/** The index `delta` steps away from `index`, kept inside the tour (the carousel's buttons stop at both ends). */
export function clampStep(index: number, delta: number, total: number = TOUR_STEPS.length): number {
  return Math.min(total - 1, Math.max(0, index + delta));
}

/** Progress of the route line for the active step, from one eighth to the whole line. */
export function routeProgress(active: number, total: number = TOUR_STEPS.length): number {
  return (clampStep(active, 0, total) + 1) / total;
}

/** Anchor of a step, for the skip links of the tour's navigation. */
export function stepAnchor(id: TourStepId): string {
  return `tour-step-${id}`;
}
