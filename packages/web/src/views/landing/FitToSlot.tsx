// A visual of the tour drawn whole inside its slot (docs/landing-spec.md §4.3): never cut, never
// scrolled inside. The visual keeps its natural layout at the slot's width and is scaled down (never
// up) until it fits the height the slot allows: a share of the viewport in the mobile carousel (the
// step and its text on one screen), or the whole box of the sticky stage on desktop, where a short
// visual sits in the middle instead of leaving an empty lower half. Only `transform`, so a change of
// size never animates the layout.
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The scale that fits `natural` inside `room`: at most 1, never 0 or negative. */
export function fitScale(natural: Size, room: Size): number {
  if (natural.width <= 0 || natural.height <= 0 || room.width <= 0 || room.height <= 0) return 1;
  return Math.max(0.1, Math.min(1, room.width / natural.width, room.height / natural.height));
}

interface FitToSlotProps {
  /** The height the visual may take: a share of the viewport's height, or the slot's own box. */
  readonly limit: { readonly viewportShare: number } | "box";
  readonly children: ReactNode;
}

interface Fit {
  readonly scale: number;
  readonly height: number;
  readonly offset: number;
}

export function FitToSlot({ limit, children }: FitToSlotProps) {
  const slot = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<Fit | undefined>(undefined);
  const share = limit === "box" ? undefined : limit.viewportShare;

  useLayoutEffect(() => {
    const outer = slot.current;
    const inner = content.current;
    if (!outer || !inner) return;
    const measure = () => {
      const natural = { width: Math.max(inner.scrollWidth, inner.offsetWidth), height: inner.offsetHeight };
      const roomHeight = share === undefined ? outer.clientHeight : window.innerHeight * share;
      const scale = fitScale(natural, { width: outer.clientWidth, height: roomHeight });
      const height = natural.height * scale;
      const offset = share === undefined ? Math.max(0, (roomHeight - height) / 2) : 0;
      setFit((current) => (current && Math.abs(current.scale - scale) < 0.001 && Math.abs(current.height - height) < 0.5 && Math.abs(current.offset - offset) < 0.5 ? current : { scale, height, offset }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    observer.observe(outer);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [share]);

  return (
    <div ref={slot} data-tour-visual="" className={`relative w-full ${share === undefined ? "h-full" : ""}`} style={share === undefined || !fit ? undefined : { height: `${fit.height}px` }}>
      <div
        ref={content}
        data-fit-scale={fit?.scale.toFixed(3)}
        className="absolute inset-x-0 top-0 origin-top"
        style={fit ? { transform: `translateY(${fit.offset}px) scale(${fit.scale})` } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
