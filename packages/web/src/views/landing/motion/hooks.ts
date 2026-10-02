// The few hooks the landing's motion needs (docs/landing-spec.md §4): whether an element is in view
// (one IntersectionObserver per use, never a scroll listener), whether a media query matches, the
// reveal of sections where scroll-driven animations do not exist, and a counter that eases to its value.
import { type RefObject, useEffect, useRef, useState } from "react";
import { counterAt } from "./schedule";

interface InViewOptions {
  readonly threshold?: number;
  readonly rootMargin?: string;
  /** Stop observing once the element has been seen. */
  readonly once?: boolean;
}

export function useInView(ref: RefObject<Element | null>, { threshold = 0, rootMargin = "0px", once = false }: InViewOptions = {}): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry?.isIntersecting ?? false;
        setInView(visible);
        if (visible && once) observer.disconnect();
      },
      { threshold, rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, threshold, rootMargin, once]);
  return inView;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Scroll-driven animations do the reveals by themselves where the browser has them. */
function hasScrollTimelines(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timeline: view()");
}

/**
 * The fallback of the sections' reveal: one IntersectionObserver for every `[data-reveal]` under
 * `root`, marking each `pending` until it is 15 % visible and `shown` after. Only while animations may
 * run; with reduced motion or paused animations nothing is marked and everything stays visible.
 */
export function useRevealFallback(root: RefObject<HTMLElement | null>, animate: boolean): void {
  useEffect(() => {
    const container = root.current;
    if (!container || !animate || hasScrollTimelines() || typeof IntersectionObserver === "undefined") return;
    const elements = [...container.querySelectorAll<HTMLElement>("[data-reveal]")];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.reveal = "shown";
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.15 },
    );
    for (const element of elements) {
      if (element.dataset.reveal === "shown") continue;
      element.dataset.reveal = "pending";
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
      for (const element of elements) element.dataset.reveal = "";
    };
  }, [root, animate]);
}

/** Counts from 0 to `target` once `start` turns true (requestAnimationFrame), or shows `target` when it may not move. */
export function useCounter(target: number, start: boolean, animate: boolean): number {
  const [value, setValue] = useState(animate ? 0 : target);
  const finished = useRef(false);
  useEffect(() => {
    if (!animate || finished.current) {
      setValue(target);
      return;
    }
    if (!start) return;
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = counterAt(target, now - startedAt);
      setValue(next);
      if (next === target) finished.current = true;
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, start, animate]);
  return value;
}

/**
 * The short sequence inside a step of the tour (≤ 1.5 s, docs/landing-spec.md §4.3): stage 0 to
 * `stages` every `stepMs` once `play` turns true; the final stage at once when it may not move.
 */
export function useSequence(play: boolean, stages: number, stepMs = 450): number {
  const [stage, setStage] = useState(play ? 0 : stages);
  useEffect(() => {
    if (!play) {
      setStage(stages);
      return;
    }
    setStage(0);
    const timers = Array.from({ length: stages }, (_, index) => window.setTimeout(() => setStage(index + 1), stepMs * (index + 1)));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [play, stages, stepMs]);
  return stage;
}
