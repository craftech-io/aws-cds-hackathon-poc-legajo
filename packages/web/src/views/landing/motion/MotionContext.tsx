// Whether the landing may move (docs/landing-spec.md §4.7): never with `prefers-reduced-motion: reduce`,
// and never once the visitor presses "Pausar animaciones" (WCAG 2.2.2), which holds for the session
// (sessionStorage, guarded) and marks `<html data-motion="off">` so the CSS stops every animation and
// transition of the public pages. Outside a provider nothing moves. React context, no state library.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export const MOTION_STORAGE_KEY = "legajo.motion";
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

interface MotionValue {
  readonly reduced: boolean;
  readonly paused: boolean;
  /** Animations may run: neither reduced motion nor paused. */
  readonly animate: boolean;
  togglePaused(): void;
}

const STILL: MotionValue = { reduced: true, paused: false, animate: false, togglePaused: () => undefined };

const MotionContext = createContext<MotionValue>(STILL);

function readPaused(): boolean {
  try {
    return window.sessionStorage.getItem(MOTION_STORAGE_KEY) === "off";
  } catch {
    return false;
  }
}

function writePaused(paused: boolean): void {
  try {
    if (paused) window.sessionStorage.setItem(MOTION_STORAGE_KEY, "off");
    else window.sessionStorage.removeItem(MOTION_STORAGE_KEY);
  } catch {
    // Storage blocked: the choice lasts for this page.
  }
}

function prefersReduced(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_QUERY).matches;
}

export function MotionProvider({ children }: { readonly children: ReactNode }) {
  const [reduced, setReduced] = useState(prefersReduced);
  const [paused, setPaused] = useState(readPaused);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_QUERY);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (paused) root.dataset.motion = "off";
    else delete root.dataset.motion;
    return () => {
      delete root.dataset.motion;
    };
  }, [paused]);

  const togglePaused = useCallback(() => {
    setPaused((current) => {
      writePaused(!current);
      return !current;
    });
  }, []);

  const value = useMemo<MotionValue>(() => ({ reduced, paused, animate: !reduced && !paused, togglePaused }), [reduced, paused, togglePaused]);
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export function useMotion(): MotionValue {
  return useContext(MotionContext);
}
