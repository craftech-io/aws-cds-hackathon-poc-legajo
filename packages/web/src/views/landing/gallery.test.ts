// The gallery and its viewer (FL-128, docs/landing-spec.md §6): the captures of the manifest in the
// order of §7.3 and no render frames; "Ampliar" on a render opens the capture that replaces it, or its
// own frame alone while the capture does not exist; the legend says each state with its copy key;
// ← → wrap around, and a swipe of 48 px of a finger or pen (never a mouse) moves to the neighbour.
import { describe, expect, it } from "vitest";
import { LANDING_COPY } from "./copy";
import { galleryItems, zoomTarget } from "./gallery";
import { swipeDirection, wrapIndex } from "./Lightbox";
import { GALLERY_IDS, type LandingManifest, ManifestEntry, mediaSrc } from "./manifest";
import type { MediaState } from "./media";
import { stateNote } from "./MediaFigure";

function sources(id: Parameters<typeof mediaSrc>[0], viewport: "desktop" | "mobile" = "desktop") {
  return { avif: [], webp: [], png: { src: mediaSrc(id, viewport, "png"), w: 960, h: 600 } };
}

const capture = (id: Parameters<typeof mediaSrc>[0], origin: "poc" | "local", viewport: "desktop" | "mobile" = "desktop") =>
  ManifestEntry.parse({ id, status: "capture", origin, viewport, sources: sources(id, viewport), capturedAt: "2026-10-02", commit: "abc1234" });
const render = ManifestEntry.parse({ id: "tour-reader", status: "render", viewport: "desktop", sources: sources("tour-reader"), component: "a.tsx#B", textSources: ["c"], replacedBy: "console-dossier-reading", replaceIn: "WP-34" });

function ready(entries: ManifestEntry[]): MediaState {
  return { status: "ready", manifest: { version: 2, entries } satisfies LandingManifest };
}

describe("gallery [FL-128]", () => {
  it("walks the captures in the order of §7.3, without render frames or the landing's own card", () => {
    const media = ready([capture("console-audit", "local"), capture("console-operations", "poc"), capture("og-card", "local"), render, capture("upload-page", "local", "mobile")]);
    expect(galleryItems(media, "desktop").map((item) => item.id)).toEqual(["console-operations", "console-audit", "upload-page"]);
    expect(GALLERY_IDS).not.toContain("og-card");
    expect(galleryItems({ status: "loading" }, "desktop")).toEqual([]);
  });

  it("opens, from a render, its capture inside the gallery, or the render's frame alone until the capture exists", () => {
    const withCapture = zoomTarget(ready([capture("console-operations", "local"), capture("console-dossier-reading", "local"), render]), "tour-reader", "console-dossier-reading", "desktop");
    expect(withCapture?.index).toBe(1);
    expect(withCapture?.items.map((item) => item.id)).toEqual(["console-operations", "console-dossier-reading"]);
    const alone = zoomTarget(ready([render]), "tour-reader", "console-dossier-reading", "desktop");
    expect(alone?.items.map((item) => [item.id, item.entry.status])).toEqual([["tour-reader", "render"]]);
    expect(zoomTarget(ready([]), "tour-reader", "console-dossier-reading", "desktop")).toBeUndefined();
  });

  it("labels each state with its copy key: none for poc, the local note, the render note, the placeholder note", () => {
    for (const lang of ["es", "en"] as const) {
      const { gallery } = LANDING_COPY[lang];
      expect(stateNote(capture("console-audit", "poc"), gallery)).toBeUndefined();
      expect(stateNote(capture("console-audit", "local"), gallery)).toBe(gallery.localNote);
      expect(stateNote(render, gallery)).toBe(gallery.renderNote);
      expect(stateNote(ManifestEntry.parse({ id: "console-audit", status: "placeholder", viewport: "desktop", sources: sources("console-audit"), replacedBy: "console-metrics", replaceIn: "WP-36" }), gallery)).toBe(gallery.placeholderNote);
    }
    expect(LANDING_COPY.es.gallery.localNote).toBe("Vista del producto");
    expect(LANDING_COPY.en.gallery.renderNote).toBe("Product view");
  });

  it("wraps ← → around the ends and turns only a long enough touch or pen swipe into a step", () => {
    expect(wrapIndex(0, -1, 5)).toBe(4);
    expect(wrapIndex(4, 1, 5)).toBe(0);
    expect(swipeDirection("touch", 300, 200)).toBe(1);
    expect(swipeDirection("pen", 100, 160)).toBe(-1);
    expect(swipeDirection("touch", 100, 140)).toBe(0);
    expect(swipeDirection("mouse", 300, 0)).toBe(0);
  });
});
