// One figure with its label: the label and the value are siblings separated by a space, so the
// figure is found from its label and stays a word of its own in the tile's text (the metrics checks
// read "Violaciones de política" and expect its 0 next to it).
import type { ReactNode } from "react";

export type StatTone = "neutral" | "success" | "warning" | "danger" | "brand";

const VALUE_TONES: Readonly<Record<StatTone, string>> = {
  neutral: "text-navy",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  brand: "text-cyan-deep",
};

interface StatTileProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly tone?: StatTone;
}

export function StatTile({ label, value, hint, tone = "neutral" }: StatTileProps) {
  return (
    <div className="rounded-md border border-mist bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</p>{" "}
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${VALUE_TONES[tone]}`}>{value}</p>{" "}
      {hint ? <p className="mt-1 text-xs text-slate">{hint}</p> : null}
    </div>
  );
}

export function StatGrid({ children }: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">{children}</div>;
}

/** What a public figure is: a design goal the console measures, or something the code guarantees. */
export type GoalKind = "goal" | "guarantee";

interface GoalTileProps {
  /** The figure as shown (it may count up); `valueText` is what assistive technology reads. */
  readonly value: ReactNode;
  readonly valueText: string;
  readonly kind: GoalKind;
  /** The visible label of `kind` ("Meta", "Garantía en código"): never colour alone. */
  readonly kindLabel: string;
  readonly kindIcon: ReactNode;
  readonly title: string;
  readonly note: string;
  /** A goal told in words (no number): the figure is a pictogram and this text sits under it, as large as a heading. */
  readonly figureText?: string;
}

/**
 * A goal of the landing's impact section (docs/landing-spec.md §1.7): never a result, always labelled
 * by kind with text and icon. The number reserves its width so counting never moves the layout; a goal
 * told in words keeps a figure of the same height (its pictogram) with the words under it.
 */
export function GoalTile({ value, valueText, kind, kindLabel, kindIcon, title, note, figureText }: GoalTileProps) {
  return (
    <div className="flex w-full flex-col gap-3 rounded-panel border border-rule bg-white p-5 shadow-card sm:p-6">
      <p className={`inline-flex w-fit items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-semibold ${kind === "goal" ? "bg-manifest-deep text-signal-ink" : "bg-manifest-deep text-glass-ink"}`}>
        {kindIcon}
        {kindLabel}
      </p>
      <p data-goal-value="" className="flex h-[1em] min-w-[5ch] items-center font-display text-counter font-semibold tabular-nums text-ink">
        <span aria-hidden="true">{value}</span>
        <span className="sr-only">{valueText}</span>
      </p>
      {figureText ? (
        <p aria-hidden="true" data-goal-figure-text="" className="font-display text-h3 font-semibold text-glass-ink">
          {figureText}
        </p>
      ) : null}
      <p className="font-display text-h3 font-semibold text-ink">{title}</p>
      <p className="text-sm leading-relaxed text-ink-muted">{note}</p>
    </div>
  );
}
