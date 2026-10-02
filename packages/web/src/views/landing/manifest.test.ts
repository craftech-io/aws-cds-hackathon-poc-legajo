// The manifest's contract (ADR-0016 §3, docs/landing-spec.md §7.4, FL-129): each state demands its
// fields and refuses the others', every file sits under its own id and viewport with its width in the
// name, a script that records a picture keeps the manifest's order, the versioned manifest parses, and
// every render the code draws (the hero and the eight steps) is in the manifest and in renders.json,
// each one replaced by a known picture.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RendersFile } from "../../../../../scripts/landing/check-rules";
import { LandingManifest, MEDIA_IDS, ManifestEntry, RENDER_IDS, bestEntry, entryProblems, mediaSrc, withEntry } from "./manifest";
import { HERO_VISUAL, TOUR_STEPS } from "./tour-steps";

const manifest = LandingManifest.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../../../public/landing/manifest.json", import.meta.url)), "utf8")));
const renders = RendersFile.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../scripts/landing/renders.json", import.meta.url)), "utf8")));

const SOURCES = { avif: [{ src: mediaSrc("console-audit", "desktop", "avif", 480), w: 480 }], webp: [{ src: mediaSrc("console-audit", "desktop", "webp", 480), w: 480 }], png: { src: mediaSrc("console-audit", "desktop", "png"), w: 2880, h: 1800 } };
const CAPTURE = { id: "console-audit", status: "capture", origin: "local", viewport: "desktop", sources: SOURCES, capturedAt: "2026-10-02", commit: "abc1234" } as const;
const RENDER = { id: "tour-reader", status: "render", viewport: "desktop", sources: { avif: [], webp: [], png: { src: mediaSrc("tour-reader", "desktop", "png"), w: 2880, h: 1800 } }, component: "a.tsx#B", textSources: ["c"], replacedBy: "console-dossier-reading", replaceIn: "WP-34" } as const;

describe("manifest v2 [FL-129]", () => {
  it("demands each state's fields and refuses the fields of the others", () => {
    expect(ManifestEntry.safeParse(CAPTURE).success).toBe(true);
    expect(ManifestEntry.safeParse(RENDER).success).toBe(true);
    expect(ManifestEntry.safeParse({ ...CAPTURE, commit: undefined }).success).toBe(false);
    expect(ManifestEntry.safeParse({ ...CAPTURE, replacedBy: "console-metrics" }).success).toBe(false);
    expect(ManifestEntry.safeParse({ ...RENDER, origin: "local" }).success).toBe(false);
    expect(ManifestEntry.safeParse({ ...RENDER, replaceIn: undefined }).success).toBe(false);
    expect(ManifestEntry.safeParse({ id: "og-card", status: "placeholder", viewport: "desktop", sources: SOURCES, replacedBy: "console-operations", replaceIn: "WP-36", component: "x" }).success).toBe(false);
    expect(ManifestEntry.safeParse({ ...CAPTURE, id: "console-cash" }).success).toBe(false);
  });

  it("keeps every file under its own id and viewport, with its width in the name, and each pair once", () => {
    expect(entryProblems(ManifestEntry.parse(CAPTURE))).toEqual([]);
    expect(ManifestEntry.safeParse({ ...CAPTURE, sources: { ...SOURCES, png: { src: "/landing/console-audit.png", w: 1, h: 1 } } }).success).toBe(false);
    expect(entryProblems(ManifestEntry.parse({ ...CAPTURE, sources: { ...SOURCES, avif: [{ src: mediaSrc("console-metrics", "desktop", "avif", 480), w: 480 }] } }))).toHaveLength(1);
    expect(entryProblems(ManifestEntry.parse({ ...CAPTURE, sources: { ...SOURCES, webp: [{ src: mediaSrc("console-audit", "desktop", "webp", 960), w: 480 }] } }))).toHaveLength(1);
    expect(LandingManifest.safeParse({ version: 2, entries: [CAPTURE, CAPTURE] }).success).toBe(false);
  });

  it("records a picture in the manifest's order and falls back to the other viewport", () => {
    const empty: LandingManifest = { version: 2, entries: [] };
    const both = withEntry(withEntry(empty, ManifestEntry.parse(RENDER)), ManifestEntry.parse(CAPTURE));
    expect(both.entries.map((entry) => entry.id)).toEqual(["console-audit", "tour-reader"]);
    expect(withEntry(both, ManifestEntry.parse({ ...CAPTURE, origin: "poc" })).entries).toHaveLength(2);
    expect(bestEntry(both, "console-audit", "mobile")?.viewport).toBe("desktop");
  });

  it("parses the versioned manifest, with every render the code draws in it and in renders.json", () => {
    const drawn = [HERO_VISUAL.render, ...TOUR_STEPS.map((step) => step.render)];
    expect(new Set(drawn)).toEqual(new Set(RENDER_IDS));
    for (const id of drawn) {
      expect(manifest.entries.some((entry) => entry.id === id && entry.status === "render"), id).toBe(true);
      expect(renders[id], id).toBeDefined();
    }
    for (const record of Object.values(renders)) expect(MEDIA_IDS).toContain(record?.replacedBy);
    for (const step of TOUR_STEPS) expect(renders[step.render]?.replacedBy).toBe(step.capture);
    expect(renders[HERO_VISUAL.render]?.replacedBy).toBe(HERO_VISUAL.capture);
  });
});
