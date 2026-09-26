// A picture of the landing, from the manifest: lazy-loaded, sized up front (no layout shift), with
// its text in the page's language, and marked when it is not a capture of the stage: a placeholder
// still waiting for one, or a capture of the local UI server ("entorno local, agente guionado",
// docs/design-brief.md §7.2). Nothing renders while the manifest loads or if it cannot be read.
import type { MediaId, MediaItem } from "./manifest";
import { type MediaState, mediaOf } from "./media";
import { useGallery } from "./gallery";
import { useLandingCopy } from "./lang";

interface MediaFigureProps {
  readonly media: MediaState;
  readonly id: MediaId;
  /** Shows the picture's caption from copy under it. */
  readonly captioned?: boolean;
  readonly className?: string;
  readonly framed?: boolean;
}

function useMark(item: MediaItem): { readonly note: string; readonly title: string } | undefined {
  const { media } = useLandingCopy();
  if (item.status === "placeholder") return { note: media.placeholderNote, title: media.placeholderTitle };
  if (item.status === "capture" && item.origin === "local") return { note: media.localNote, title: media.localTitle };
  return undefined;
}

function Picture({ item, alt, className }: { readonly item: MediaItem; readonly alt: string; readonly className: string }) {
  return <img src={item.file} alt={alt} width={item.width} height={item.height} loading="lazy" decoding="async" className={className} />;
}

function Figure({ id, item, captioned, className, framed }: { readonly id: MediaId; readonly item: MediaItem; readonly captioned: boolean; readonly className: string; readonly framed: boolean }) {
  const landingCopy = useLandingCopy();
  const gallery = useGallery();
  const mark = useMark(item);
  const text = landingCopy.media.items[id];
  return (
    <figure className={className}>
      <div className={`relative overflow-hidden ${framed ? "rounded-card border border-mist bg-white shadow-card" : ""}`}>
        {gallery ? (
          <button type="button" onClick={() => gallery.open(id)} aria-label={`${landingCopy.zoom.open}: ${text.alt}`} className="group block w-full cursor-zoom-in">
            <Picture item={item} alt={text.alt} className="block h-auto w-full transition group-hover:opacity-95" />
          </button>
        ) : (
          <Picture item={item} alt={text.alt} className="block h-auto w-full" />
        )}
        {mark ? (
          <span title={mark.title} className="absolute bottom-2 right-2 rounded-full bg-navy/85 px-2 py-0.5 text-xs font-medium text-white">
            {mark.note}
          </span>
        ) : null}
      </div>
      {captioned ? <figcaption className="mt-2 text-xs text-slate">{text.caption}</figcaption> : null}
    </figure>
  );
}

export function MediaFigure({ media, id, captioned = false, className = "", framed = true }: MediaFigureProps) {
  const item = mediaOf(media, id);
  if (!item) return media.status === "loading" ? <div aria-hidden="true" className={`min-h-40 animate-pulse rounded-card bg-mist ${className}`} /> : null;
  return <Figure id={id} item={item} captioned={captioned} className={className} framed={framed} />;
}
