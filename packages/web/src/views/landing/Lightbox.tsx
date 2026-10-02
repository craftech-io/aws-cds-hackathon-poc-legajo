// The gallery's viewer (docs/landing-spec.md §6, G-1 to G-10): a native modal `<dialog>` (Escape, focus
// trap and backdrop come from the browser), loaded as its own chunk on first use. Previous and next by
// 44 px buttons, the ← and → keys or a horizontal swipe of a finger or pen (48 px, the picture leaves
// sideways in 200 ms unless motion is reduced); a click outside the picture, the close button or Escape
// closes it and the opener gets the focus back. The picture comes as AVIF/WebP/PNG at the viewport's
// width and can be shown at its actual size; the neighbours are fetched ahead. The legend is the
// caption, the state label and "3 de 12", announced politely. The page does not scroll underneath.
// Toolbar, picture and caption are three rows of a grid, and the arrows sit beside the picture (or in
// the caption row on a phone): no control ever covers the capture it shows. On a phone the backdrop is
// opaque, so no text of the page shows around the picture; from 640 px a hint of the page stays behind.
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import type { GalleryItem } from "./gallery";
import { Icon } from "./icons";
import { useLandingCopy } from "./lang";
import { Picture, stateNote } from "./MediaFigure";
import { useMotion } from "./motion/MotionContext";

interface LightboxProps {
  readonly items: readonly GalleryItem[];
  readonly index: number;
  readonly onIndex: (index: number) => void;
  readonly onClose: () => void;
}

export const SWIPE_PX = 48;
const SCROLL_LOCK = ["overflow-hidden", "[scrollbar-gutter:stable]"];
const CONTROL = "flex h-11 w-11 items-center justify-center rounded-full bg-harbor-900 text-foam shadow-float hover:bg-harbor-800";

/** The neighbour `delta` steps away, wrapping around the ends. */
export function wrapIndex(index: number, delta: number, total: number): number {
  return total === 0 ? 0 : (index + delta + total) % total;
}

/** The swipe a pointer made: `1` next, `-1` previous, `0` none (a mouse never swipes). */
export function swipeDirection(pointerType: string, fromX: number, toX: number): -1 | 0 | 1 {
  if (pointerType === "mouse") return 0;
  const delta = toX - fromX;
  if (Math.abs(delta) < SWIPE_PX) return 0;
  return delta < 0 ? 1 : -1;
}

function prefetch(item: GalleryItem | undefined): void {
  if (!item) return;
  const widths = item.entry.sources.webp;
  const fit = widths.find((variant) => variant.w >= window.innerWidth * window.devicePixelRatio) ?? widths[widths.length - 1];
  const image = new Image();
  image.decoding = "async";
  image.src = fit?.src ?? item.entry.sources.png.src;
}

export default function Lightbox({ items, index, onIndex, onClose }: LightboxProps) {
  const copy = useLandingCopy();
  const { animate } = useMotion();
  const dialog = useRef<HTMLDialogElement>(null);
  const swipeFrom = useRef<{ readonly x: number; readonly type: string } | undefined>(undefined);
  const [leaving, setLeaving] = useState<-1 | 1 | undefined>(undefined);
  const [actual, setActual] = useState(false);
  const item = items[index];
  const text = item ? copy.media.items[item.id] : undefined;
  const note = item ? stateNote(item.entry, copy.gallery) : undefined;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    // The page underneath does not scroll; its scrollbar's room stays, so nothing reflows or jumps.
    const root = document.documentElement;
    root.classList.add(...SCROLL_LOCK);
    return () => {
      root.classList.remove(...SCROLL_LOCK);
      if (element?.open) element.close();
    };
  }, []);

  useEffect(() => {
    setActual(false);
    prefetch(items[wrapIndex(index, 1, items.length)]);
    prefetch(items[wrapIndex(index, -1, items.length)]);
  }, [index, items]);

  const step = (delta: -1 | 1) => {
    if (items.length < 2) return;
    if (!animate) {
      onIndex(wrapIndex(index, delta, items.length));
      return;
    }
    setLeaving(delta);
    window.setTimeout(() => {
      setLeaving(undefined);
      onIndex(wrapIndex(index, delta, items.length));
    }, 200);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "ArrowRight") step(1);
    if (event.key === "ArrowLeft") step(-1);
    // Handled here too: the dialog's own Escape only closes it for trusted key presses.
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    swipeFrom.current = { x: event.clientX, type: event.pointerType };
  };
  const onPointerUp = (event: PointerEvent) => {
    const from = swipeFrom.current;
    swipeFrom.current = undefined;
    if (!from) return;
    const direction = swipeDirection(from.type, from.x, event.clientX);
    if (direction !== 0) step(direction);
  };
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const motion = leaving === undefined ? "" : `transition-[transform,opacity] duration-200 opacity-0 ${leaving === 1 ? "-translate-x-12" : "translate-x-12"}`;

  const arrow = (delta: -1 | 1, where: string) => (
    <button
      type="button"
      aria-label={delta === -1 ? copy.zoom.previous : copy.zoom.next}
      data-lightbox-arrow={delta === -1 ? "previous" : "next"}
      onClick={(event) => (stop(event), step(delta))}
      className={`${CONTROL} shrink-0 ${where}`}
    >
      <Icon name={delta === -1 ? "chevronLeft" : "chevronRight"} />
    </button>
  );
  const several = items.length > 1;

  return (
    <dialog
      ref={dialog}
      aria-label={text?.alt ?? copy.gallery.title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={onClose}
      onKeyDown={onKeyDown}
      className="m-0 h-dvh max-h-none w-dvw max-w-none bg-transparent p-0 text-foam backdrop:bg-harbor-950 open:animate-stage-in sm:backdrop:bg-harbor-950/90"
    >
      {item && text ? (
        // Three rows that never overlap: the toolbar, the picture, the caption. No control sits on the picture.
        <div className="grid h-full w-full grid-rows-[auto_minmax(0,1fr)_auto] gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:gap-3 sm:px-4">
          <div data-lightbox-toolbar="" className="flex items-center justify-between gap-3">
            <p aria-live="polite" className="rounded-pill bg-harbor-950 px-3 py-1 text-sm text-foam-muted">
              {copy.zoom.counter(index + 1, items.length)}
            </p>
            <button type="button" aria-label={copy.zoom.close} title={copy.zoom.close} onClick={onClose} className={CONTROL}>
              <Icon name="cross" />
            </button>
          </div>
          <div className="flex min-h-0 items-center gap-3">
            {several ? arrow(-1, "hidden sm:flex") : null}
            <div data-lightbox-frame="" className={`flex h-full min-h-0 min-w-0 flex-1 justify-center ${actual ? "items-start overflow-auto" : "items-center"}`}>
              <div onPointerDown={onPointerDown} onPointerUp={onPointerUp} className={`touch-pan-y touch-pinch-zoom ${actual ? "" : "flex h-full w-full items-center justify-center"} ${motion}`}>
                {/* Only the picture itself keeps a click from closing the viewer. */}
                <span className="contents" onClick={stop}>
                  <Picture
                    entry={item.entry}
                    alt={text.alt}
                    sizes="100vw"
                    eager
                    unboxed
                    className={actual ? "max-w-none rounded-card shadow-float" : "max-h-full max-w-full select-none rounded-card object-contain shadow-float"}
                  />
                </span>
              </div>
            </div>
            {several ? arrow(1, "hidden sm:flex") : null}
          </div>
          <div data-lightbox-caption="" onClick={stop} className="mx-auto flex w-full max-w-3xl items-center gap-2 rounded-panel bg-harbor-950 px-2 py-2 text-sm text-foam sm:px-4">
            {several ? arrow(-1, "sm:hidden") : null}
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center">
              <p>
                {text.caption}
                {note ? <span className="ml-2 inline-flex rounded-pill bg-harbor-800 px-2 py-0.5 text-xs font-semibold text-foam">{note}</span> : null}
              </p>
              <button type="button" aria-pressed={actual} onClick={() => setActual((value) => !value)} className="inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-harbor-900 px-4 text-xs font-semibold text-foam hover:bg-harbor-800">
                <Icon name="enlarge" className="h-4 w-4" />
                {copy.zoom.actualSize}
              </button>
            </div>
            {several ? arrow(1, "sm:hidden") : null}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
