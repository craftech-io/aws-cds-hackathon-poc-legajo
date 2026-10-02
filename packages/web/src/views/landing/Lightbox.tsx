// The gallery's viewer (docs/landing-spec.md §6, G-1 to G-10): a native modal `<dialog>` (Escape, focus
// trap and backdrop come from the browser), loaded as its own chunk on first use. Previous and next by
// 44 px buttons, the ← and → keys or a horizontal swipe of a finger or pen (48 px, the picture leaves
// sideways in 200 ms unless motion is reduced); a click outside the picture, the close button or Escape
// closes it and the opener gets the focus back. The picture comes as AVIF/WebP/PNG at the viewport's
// width and can be shown at its actual size; the neighbours are fetched ahead. The legend is the
// caption, the state label and "3 de 12", announced politely. The page does not scroll underneath.
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
      className="m-0 h-dvh max-h-none w-dvw max-w-none bg-transparent p-0 text-foam backdrop:bg-harbor-950/90 open:animate-stage-in"
    >
      {item && text ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(4rem,env(safe-area-inset-top))] sm:px-16">
          <div className={`flex min-h-0 w-full flex-1 items-center justify-center ${actual ? "overflow-auto" : ""}`}>
            <div onPointerDown={onPointerDown} onPointerUp={onPointerUp} className={`touch-pan-y touch-pinch-zoom ${actual ? "" : "flex h-full w-full items-center justify-center"} ${motion}`}>
              {/* Only the picture itself keeps a click from closing the viewer. */}
              <span className="contents" onClick={stop}>
                <Picture
                  entry={item.entry}
                  alt={text.alt}
                  sizes="100vw"
                  eager
                  className={actual ? "max-w-none rounded-card shadow-float" : "max-h-full max-w-full select-none rounded-card object-contain shadow-float"}
                />
              </span>
            </div>
          </div>
          <div onClick={stop} className="flex w-full max-w-3xl flex-wrap items-center justify-center gap-3 rounded-panel bg-harbor-950 px-4 py-2 text-center text-sm text-foam">
            <p>
              {text.caption}
              {note ? <span className="ml-2 inline-flex rounded-pill bg-harbor-800 px-2 py-0.5 text-xs font-semibold text-foam">{note}</span> : null}
            </p>
            <p aria-live="polite" className="text-foam-muted">
              {copy.zoom.counter(index + 1, items.length)}
            </p>
            <button type="button" aria-pressed={actual} onClick={() => setActual((value) => !value)} className="inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-harbor-900 px-4 text-xs font-semibold text-foam hover:bg-harbor-800">
              <Icon name="enlarge" className="h-4 w-4" />
              {copy.zoom.actualSize}
            </button>
          </div>
          {items.length > 1 ? (
            <>
              <button type="button" aria-label={copy.zoom.previous} onClick={(event) => (stop(event), step(-1))} className={`${CONTROL} absolute left-2 top-1/2 -translate-y-1/2 sm:left-4`}>
                <Icon name="chevronLeft" />
              </button>
              <button type="button" aria-label={copy.zoom.next} onClick={(event) => (stop(event), step(1))} className={`${CONTROL} absolute right-2 top-1/2 -translate-y-1/2 sm:right-4`}>
                <Icon name="chevronRight" />
              </button>
            </>
          ) : null}
          <button type="button" aria-label={copy.zoom.close} title={copy.zoom.close} onClick={onClose} className={`${CONTROL} absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))]`}>
            <Icon name="cross" />
          </button>
        </div>
      ) : null}
    </dialog>
  );
}
