// "Impacto" (docs/landing-spec.md §1.7 and §4.5): goals the buyer is after, never results. Three
// goals the console measures in every world with its N ("Meta") and one guarantee in code; each
// counter eases from 0 to its value once, when its tile is half visible (the final value from the
// start with reduced motion), and the number is read from a visually hidden text. "El mismo día" has
// no number: its figure is a clock as tall as the counters, with the words under it. The footnote says
// how the demo measures them and labels the delay risk as an assumption.
import { useRef } from "react";
import { GoalTile } from "../../components/StatTile";
import { SectionShell } from "../../components/Section";
import { IMPACT_TILES } from "./goals";
import { Icon } from "./icons";
import { useLandingCopy } from "./lang";
import { useCounter, useInView } from "./motion/hooks";
import { useMotion } from "./motion/MotionContext";

type Tile = (typeof IMPACT_TILES)[number];

function ImpactTile({ tile }: { readonly tile: Tile }) {
  const { impact } = useLandingCopy();
  const { animate } = useMotion();
  const ref = useRef<HTMLLIElement>(null);
  const inView = useInView(ref, { threshold: 0.5, once: true });
  const target = tile.count ?? 0;
  const value = useCounter(target, inView, animate && tile.count !== undefined);
  const text = impact.tiles[tile.id];
  const final = text.value(target);
  return (
    <li ref={ref} data-reveal="" data-goal-tile={tile.id} className="flex">
      <GoalTile
        value={tile.count === undefined ? <Icon name="clock" className="h-[0.9em] w-[0.9em] shrink-0 text-glass-ink" /> : text.value(value)}
        valueText={final}
        {...(tile.count === undefined ? { figureText: final } : {})}
        kind={tile.kind}
        kindLabel={tile.kind === "goal" ? impact.labels.goal : impact.labels.guarantee}
        kindIcon={<Icon name={tile.kind === "goal" ? "route" : "shield"} className="h-3.5 w-3.5" />}
        title={text.title}
        note={text.note}
      />
    </li>
  );
}

export function ImpactSection() {
  const { impact } = useLandingCopy();
  return (
    <SectionShell id="impact" eyebrow={impact.eyebrow} title={impact.title} lead={impact.lead} tone="alt">
      <ul className="grid grid-cols-1 gap-4 min-[24rem]:grid-cols-2 lg:grid-cols-4">
        {IMPACT_TILES.map((tile) => (
          <ImpactTile key={tile.id} tile={tile} />
        ))}
      </ul>
      <div className="mt-8 flex max-w-prose flex-col gap-3 text-sm text-ink-muted">
        <p>{impact.footnote}</p>
        <p className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-white px-2.5 py-1 text-xs font-semibold text-ink">
            <Icon name="policy" className="h-3.5 w-3.5" />
            {impact.labels.assumption}
          </span>
          <span>{impact.assumptions}</span>
        </p>
      </div>
    </SectionShell>
  );
}
