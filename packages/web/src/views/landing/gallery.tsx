// One gallery for every picture of the landing (docs/landing-spec.md §6): the captures of the
// manifest in the order of §7.3 (G-11), which any figure or "Ampliar" opens at its own picture and
// the viewer walks. A render's still frame is not a gallery item: "Ampliar" on a render opens the
// capture that replaces it once it exists, or else the render's frame alone, with its label. The
// viewer itself is a separate chunk, loaded on first use or when the visitor nears the gallery (G-10).
// React context, no state library.
import { type ReactNode, Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { GALLERY_IDS, type ManifestEntry, type MediaId, type Viewport, bestEntry } from "./manifest";
import type { MediaState } from "./media";

const Lightbox = lazy(() => import("./Lightbox"));

/** Loads the viewer's chunk ahead of the first click (the visitor is near the gallery). */
export function prefetchLightbox(): void {
  void import("./Lightbox");
}

export interface GalleryItem {
  readonly id: MediaId;
  readonly entry: ManifestEntry;
}

/** The gallery's items for a viewport: every capture of `GALLERY_IDS` the manifest has, in that order. */
export function galleryItems(media: MediaState, viewport: Viewport): GalleryItem[] {
  if (media.status !== "ready") return [];
  return GALLERY_IDS.flatMap((id) => {
    const entry = bestEntry(media.manifest, id, viewport);
    return entry && entry.status !== "render" ? [{ id, entry }] : [];
  });
}

/**
 * What "Ampliar" opens for `id` (a render or a capture): the gallery at that capture, or at the capture
 * that replaces the render, or the render's own frame by itself; nothing while the manifest has neither.
 */
export function zoomTarget(media: MediaState, id: MediaId, replacedBy: MediaId | undefined, viewport: Viewport): { readonly items: GalleryItem[]; readonly index: number } | undefined {
  const items = galleryItems(media, viewport);
  for (const candidate of [id, replacedBy]) {
    const index = items.findIndex((item) => item.id === candidate);
    if (index >= 0) return { items, index };
  }
  if (media.status !== "ready") return undefined;
  const entry = bestEntry(media.manifest, id, viewport);
  return entry ? { items: [{ id, entry }], index: 0 } : undefined;
}

interface GalleryValue {
  /** Opens the viewer on `id` (or on the capture that replaces it); false when there is nothing to show. */
  open(id: MediaId, replacedBy?: MediaId): boolean;
  /** "Ampliar" is offered only when it would open something. */
  canOpen(id: MediaId, replacedBy?: MediaId): boolean;
}

const GalleryContext = createContext<GalleryValue | undefined>(undefined);

interface Opened {
  readonly items: readonly GalleryItem[];
  readonly index: number;
}

export function GalleryProvider({ media, viewport, children }: { readonly media: MediaState; readonly viewport: Viewport; readonly children: ReactNode }) {
  const [opened, setOpened] = useState<Opened | undefined>(undefined);
  /** What had the focus when the viewer opened, to give it back once it is gone (G-2). */
  const opener = useRef<HTMLElement | null>(null);

  const canOpen = useCallback((id: MediaId, replacedBy?: MediaId) => zoomTarget(media, id, replacedBy, viewport) !== undefined, [media, viewport]);
  const open = useCallback(
    (id: MediaId, replacedBy?: MediaId) => {
      const target = zoomTarget(media, id, replacedBy, viewport);
      if (!target) return false;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpened(target);
      return true;
    },
    [media, viewport],
  );

  const close = useCallback(() => setOpened(undefined), []);

  useEffect(() => {
    if (opened !== undefined || !opener.current) return;
    opener.current.focus({ preventScroll: true });
    opener.current = null;
  }, [opened]);

  const value = useMemo(() => ({ open, canOpen }), [open, canOpen]);
  return (
    <GalleryContext.Provider value={value}>
      {children}
      {opened ? (
        <Suspense fallback={null}>
          <Lightbox items={opened.items} index={opened.index} onIndex={(index) => setOpened((current) => (current ? { ...current, index } : current))} onClose={close} />
        </Suspense>
      ) : null}
    </GalleryContext.Provider>
  );
}

/** `undefined` outside a GalleryProvider: the figure then renders without zoom. */
export function useGallery(): GalleryValue | undefined {
  return useContext(GalleryContext);
}
