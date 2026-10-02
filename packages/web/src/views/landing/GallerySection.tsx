// "La consola" (docs/landing-spec.md §6 and §7.3): the captures of the real console over the synthetic
// world, in the order of the tour, each one zoomable in the gallery's viewer with its state label
// (a local capture says so). Nearing the section loads the viewer's chunk; while the manifest loads
// the section says so, and if it cannot be read it says the rest of the page works the same.
import { useEffect, useRef } from "react";
import { SectionShell } from "../../components/Section";
import { GALLERY_IDS } from "./manifest";
import { prefetchLightbox } from "./gallery";
import { useLandingCopy } from "./lang";
import { MediaFigure } from "./MediaFigure";
import type { MediaState } from "./media";
import { useInView } from "./motion/hooks";

export function GallerySection({ media }: { readonly media: MediaState }) {
  const { gallery, media: mediaCopy } = useLandingCopy();
  const ref = useRef<HTMLDivElement>(null);
  const near = useInView(ref, { rootMargin: "600px 0px", once: true });
  useEffect(() => {
    if (near) prefetchLightbox();
  }, [near]);
  return (
    <SectionShell id="gallery" eyebrow={gallery.eyebrow} title={gallery.title} lead={gallery.lead} tone="alt">
      <div ref={ref}>
        {media.status === "loading" ? <p className="text-sm text-ink-muted">{mediaCopy.loading}</p> : null}
        {media.status === "unavailable" ? <p className="max-w-prose rounded-panel border border-rule bg-white px-4 py-3 text-sm text-ink-muted">{mediaCopy.unavailable}</p> : null}
        {media.status === "ready" ? (
          <ul className="grid gap-6 min-[24rem]:grid-cols-2 md:grid-cols-3 2xl:grid-cols-4">
            {GALLERY_IDS.map((id) => (
              <li key={id} className="empty:hidden">
                <MediaFigure media={media} id={id} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </SectionShell>
  );
}
