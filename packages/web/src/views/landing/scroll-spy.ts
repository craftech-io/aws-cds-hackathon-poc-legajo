// Which section of the page the visitor is reading, for the header's links (docs/landing-spec.md §5.1).
// One IntersectionObserver watches a thin band a third of the way down the screen; the section that
// crosses it is the current one. Nothing is current while the band is over a section the header does
// not link (the hero, the problem, the video…).
import { useEffect, useState } from "react";

/** The band: from 35 % to 40 % of the viewport's height, measured from its top. */
export const SPY_MARGIN = "-35% 0px -60% 0px";

/** The last of `ids`, in page order, whose section is crossing the band; `undefined` when none is. */
export function pickActive(ids: readonly string[], crossing: ReadonlySet<string>): string | undefined {
  return [...ids].reverse().find((id) => crossing.has(id));
}

export function useActiveSection(ids: readonly string[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const crossing = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) crossing.add(entry.target.id);
          else crossing.delete(entry.target.id);
        }
        setActive(pickActive(ids, crossing));
      },
      { rootMargin: SPY_MARGIN },
    );
    for (const id of ids) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}
