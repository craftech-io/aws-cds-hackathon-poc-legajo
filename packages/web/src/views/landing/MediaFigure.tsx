// A picture of the landing from the manifest (docs/landing-spec.md §5.3 and §6): a `<picture>` with
// AVIF and WebP by width and the PNG as the fallback (G-3), the phone-sized capture below 768 px when
// there is one, sized up front from the manifest (no layout shift), lazy below the fold. Its caption
// carries the label of its state (G-4): none for a capture of `poc`, "Entorno local, agente guionado"
// for a local capture, "Animación con los componentes y textos del producto" for a render's frame,
// "Imagen provisoria" for a placeholder.
import type { LandingCopy } from "./copy";
import { useGallery } from "./gallery";
import { Icon } from "./icons";
import { useLandingCopy } from "./lang";
import { type ManifestEntry, type MediaId, entryOf } from "./manifest";
import type { MediaState } from "./media";

/** The label of an entry's state, from copy; `undefined` for a capture of the deployed stage. */
export function stateNote(entry: ManifestEntry, gallery: LandingCopy["gallery"]): string | undefined {
  if (entry.status === "render") return gallery.renderNote;
  if (entry.status === "placeholder") return gallery.placeholderNote;
  return entry.origin === "local" ? gallery.localNote : undefined;
}

function srcSet(variants: ReadonlyArray<{ readonly src: string; readonly w: number }>): string {
  return variants.map((variant) => `${variant.src} ${variant.w}w`).join(", ");
}

const PHONE_MEDIA = "(max-width: 767px)";

interface PictureProps {
  readonly entry: ManifestEntry;
  /** The phone-sized capture of the same id, for screens under 768 px. */
  readonly mobile?: ManifestEntry;
  readonly alt: string;
  readonly sizes: string;
  readonly className: string;
  /** The viewer shows the picture now: no lazy loading. */
  readonly eager?: boolean;
}

export function Picture({ entry, mobile, alt, sizes, className, eager = false }: PictureProps) {
  const art = mobile && mobile !== entry ? mobile : undefined;
  return (
    <picture>
      {art && art.sources.avif.length > 0 ? <source media={PHONE_MEDIA} type="image/avif" srcSet={srcSet(art.sources.avif)} sizes={sizes} /> : null}
      {art && art.sources.webp.length > 0 ? <source media={PHONE_MEDIA} type="image/webp" srcSet={srcSet(art.sources.webp)} sizes={sizes} /> : null}
      {entry.sources.avif.length > 0 ? <source type="image/avif" srcSet={srcSet(entry.sources.avif)} sizes={sizes} /> : null}
      {entry.sources.webp.length > 0 ? <source type="image/webp" srcSet={srcSet(entry.sources.webp)} sizes={sizes} /> : null}
      <img src={entry.sources.png.src} alt={alt} width={entry.sources.png.w} height={entry.sources.png.h} loading={eager ? "eager" : "lazy"} decoding="async" draggable={false} className={className} />
    </picture>
  );
}

/** A capture of the gallery: the picture as a button that opens the viewer, with its caption and state label. */
export function MediaFigure({ media, id }: { readonly media: MediaState; readonly id: MediaId }) {
  const copy = useLandingCopy();
  const gallery = useGallery();
  if (media.status !== "ready") return null;
  const desktop = entryOf(media.manifest, id, "desktop");
  const mobile = entryOf(media.manifest, id, "mobile");
  const entry = desktop ?? mobile;
  if (!entry) return null;
  const text = copy.media.items[id];
  const note = stateNote(entry, copy.gallery);
  return (
    <figure className="group flex flex-col">
      <button
        type="button"
        onClick={() => gallery?.open(id)}
        aria-label={copy.zoom.open(text.alt)}
        className="relative block overflow-hidden rounded-panel border border-rule bg-white shadow-card cursor-zoom-in"
      >
        <Picture entry={entry} {...(mobile ? { mobile } : {})} alt={text.alt} sizes="(min-width: 1440px) 25vw, (min-width: 768px) 33vw, (min-width: 390px) 50vw, 100vw" className="block aspect-16/10 h-auto w-full object-cover object-top transition-transform duration-300 group-hover:scale-102" />
        <span aria-hidden="true" className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-harbor-950/80 text-foam opacity-0 transition-opacity group-hover:opacity-100">
          <Icon name="enlarge" className="h-4 w-4" />
        </span>
      </button>
      <figcaption className="mt-2 text-sm text-ink-muted">
        {text.caption}
        {note ? <span className="ml-2 inline-flex rounded-pill bg-white px-2 py-0.5 text-xs font-semibold text-ink">{note}</span> : null}
      </figcaption>
    </figure>
  );
}
