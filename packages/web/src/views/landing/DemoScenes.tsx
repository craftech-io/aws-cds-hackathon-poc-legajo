// The story of operation 4471 as a stepped sequence (scenes.ts): one tab per scene, the caption on one
// side and what the parties see on the other. It advances on its own every few seconds until the
// visitor takes over (never with reduced motion), and pauses while hovered or focused.
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { useLandingCopy } from "./lang";
import type { MediaState } from "./media";
import { SCENES } from "./scenes";
import { SceneVisual } from "./SceneVisuals";

/** Matches `--animate-scene-progress` of index.css (the bar under the current tab). */
const ADVANCE_MS = 9_000;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function DemoScenes({ media }: { readonly media: MediaState }) {
  const { story } = useLandingCopy();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [held, setHeld] = useState(false);
  const scene = SCENES[index] ?? SCENES[0];
  const go = useCallback((next: number) => setIndex((next + SCENES.length) % SCENES.length), []);

  useEffect(() => {
    if (!playing || held) return;
    const timer = window.setTimeout(() => go(index + 1), ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [playing, held, index, go]);

  const choose = (next: number) => {
    setPlaying(false);
    go(next);
  };

  // Tabs pattern: arrows, Home and End move the selection and the focus together.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Readonly<Record<string, number>> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: SCENES.length - 1 };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = (target + SCENES.length) % SCENES.length;
    choose(next);
    document.getElementById(`scene-tab-${SCENES[next]?.id ?? ""}`)?.focus();
  };

  if (!scene) return null;
  const text = story.scenes[scene.id];
  return (
    <div onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <div role="tablist" aria-label={story.tabsLabel} onKeyDown={onTabKey} className="flex gap-2 overflow-x-auto pb-2">
        {SCENES.map((candidate, candidateIndex) => {
          const active = candidateIndex === index;
          return (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              id={`scene-tab-${candidate.id}`}
              aria-selected={active}
              aria-controls="scene-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => choose(candidateIndex)}
              className={`relative shrink-0 overflow-hidden rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                active ? "border-navy bg-navy text-white" : "border-mist bg-white text-slate hover:border-cyan-deep hover:text-navy"
              }`}
            >
              {candidateIndex + 1}. {story.scenes[candidate.id].title}
              {active && playing && !held ? <span aria-hidden="true" key={index} className="absolute inset-x-0 bottom-0 h-0.5 origin-left animate-scene-progress bg-cyan motion-reduce:animate-none" /> : null}
            </button>
          );
        })}
      </div>

      <div id="scene-panel" role="tabpanel" aria-labelledby={`scene-tab-${scene.id}`} className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex flex-col gap-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-cyan-deep">
            {story.sceneLabel(index + 1, SCENES.length)} · {text.channel}
          </p>
          <h3 className="text-2xl font-semibold text-navy">{text.title}</h3>
          {scene.when ? (
            <p className="w-fit rounded-full bg-cyan-soft px-3 py-1 text-xs font-semibold text-cyan-deep">
              {story.simTime} · {scene.when}
            </p>
          ) : null}
          <p className="text-base leading-relaxed text-ink">{text.text}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => choose(index - 1)} className="rounded-md border border-mist bg-white px-3 py-2 text-sm font-semibold text-navy hover:bg-paper">
              ← {story.previous}
            </button>
            <button type="button" onClick={() => choose(index + 1)} className="rounded-md bg-navy px-3 py-2 text-sm font-semibold text-white hover:bg-navy-soft">
              {story.next} →
            </button>
            <button type="button" onClick={() => setPlaying((value) => !value)} aria-pressed={playing} className="rounded-md px-3 py-2 text-sm font-semibold text-cyan-deep hover:bg-cyan-soft">
              {playing ? story.pause : story.play}
            </button>
          </div>
        </div>
        <div key={scene.id} className="animate-scene-in motion-reduce:animate-none">
          <SceneVisual scene={scene} media={media} />
        </div>
      </div>
    </div>
  );
}
