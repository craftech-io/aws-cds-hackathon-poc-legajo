// `npm run landing:check` (FL-129, ADR-0016 §4): each rule over a small fixture of manifest, render list,
// files and texts. A `swap` render fails once its capture comes from `poc`; a `zoom` render never does,
// and a `local` capture never triggers the swap, so stage A2 passes with every capture local.
import { describe, expect, it } from "vitest";
import type { ManifestEntry } from "../../packages/web/src/views/landing/manifest";
import { type CheckInput, type RenderRecord, landingProblems, rendersReport } from "./check-rules";

const sources = (id: string, viewport: "desktop" | "mobile" = "desktop") => ({
  avif: [{ src: `/landing/${id}/${viewport}-480.avif`, w: 480 }],
  webp: [{ src: `/landing/${id}/${viewport}-480.webp`, w: 480 }],
  png: { src: `/landing/${id}/${viewport}.png`, w: 960, h: 600 },
});

function capture(id: string, origin: "poc" | "local"): ManifestEntry {
  return { id, status: "capture", origin, viewport: "desktop", sources: sources(id), capturedAt: "2026-10-02", commit: "abc1234" } as ManifestEntry;
}

function render(id: string, replacedBy: string): ManifestEntry {
  return { id, status: "render", viewport: "desktop", sources: { avif: [], webp: [], png: { src: `/landing/${id}/desktop.png`, w: 960, h: 600 } }, component: "packages/web/src/views/landing/SceneVisuals.tsx#ReaderCard", textSources: ["views/landing/scenes.ts#READINGS"], replacedBy, replaceIn: "WP-34" } as ManifestEntry;
}

function record(replacedBy: string, policy: "swap" | "zoom"): RenderRecord {
  return { component: "packages/web/src/views/landing/SceneVisuals.tsx#ReaderCard", textSources: ["views/landing/scenes.ts#READINGS"], replacedBy: replacedBy as RenderRecord["replacedBy"], replaceIn: "WP-34", reason: "why", policy, until: "SC-24 en verde en poc" };
}

const TEXT = { alt: "alt", caption: "caption" };
const TEXTS = { "console-dossier-reading": TEXT, "tour-reader": TEXT };

function input(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    manifest: { version: 2, entries: [capture("console-dossier-reading", "local"), render("tour-reader", "console-dossier-reading")] },
    renders: { "tour-reader": record("console-dossier-reading", "swap") },
    usedIds: ["tour-reader", "console-dossier-reading"],
    fileExists: () => true,
    componentSource: () => "export function ReaderCard() {}",
    mediaTexts: { es: TEXTS, en: TEXTS },
    ...overrides,
  };
}

describe("landing:check [FL-129]", () => {
  it("passes with local captures and their renders", () => {
    expect(landingProblems(input())).toEqual([]);
  });

  it("refuses a manifest whose entry carries the fields of another state or misses its own", () => {
    const withOrigin = { ...render("tour-reader", "console-dossier-reading"), origin: "local" };
    expect(landingProblems(input({ manifest: { version: 2, entries: [withOrigin] } })).join()).toMatch(/manifest/);
    const { commit: _commit, ...noCommit } = capture("console-dossier-reading", "local") as Extract<ManifestEntry, { status: "capture" }>;
    expect(landingProblems(input({ manifest: { version: 2, entries: [noCommit] } })).join()).toMatch(/manifest/);
    expect(landingProblems(input({ manifest: { version: 1, media: {} } })).join()).toMatch(/manifest/);
  });

  it("fails a missing file and an id the landing uses without an entry", () => {
    expect(landingProblems(input({ fileExists: (src) => !src.endsWith(".avif") }))).toContain("console-dossier-reading/desktop: /landing/console-dossier-reading/desktop-480.avif does not exist");
    expect(landingProblems(input({ usedIds: ["tour-reader", "console-dossier-reading", "console-audit"] }))).toContain("console-audit: the landing uses it but the manifest has no entry");
  });

  it("keeps the manifest's renders and renders.json in step, field by field, and both ways", () => {
    expect(landingProblems(input({ renders: {} }))).toContain("tour-reader: render of the manifest missing from renders.json");
    expect(landingProblems(input({ renders: { "tour-reader": { ...record("console-dossier-reading", "swap"), replaceIn: "WP-35" } } })).join()).toMatch(/differ from renders.json/);
    expect(landingProblems(input({ renders: { "tour-reader": record("console-dossier-reading", "swap"), "tour-eta": record("console-clock", "swap") } }))).toContain("tour-eta: render of renders.json missing from the manifest");
    expect(landingProblems(input({ renders: { "tour-reader": { ...record("console-dossier-reading", "swap"), policy: "later" } } })).join()).toMatch(/renders\.json/);
  });

  it("fails a swap render once its capture is from poc, and never a zoom render", () => {
    const fromPoc = { version: 2, entries: [capture("console-dossier-reading", "poc"), render("tour-reader", "console-dossier-reading")] };
    expect(landingProblems(input({ manifest: fromPoc })).join()).toMatch(/tour-reader: swap render whose capture console-dossier-reading is already from poc/);
    expect(landingProblems(input({ manifest: fromPoc, renders: { "tour-reader": record("console-dossier-reading", "zoom") } }))).toEqual([]);
  });

  it("never takes a placeholder in the hero or as og-card", () => {
    const placeholder = { id: "og-card", status: "placeholder", viewport: "desktop", sources: sources("og-card"), replacedBy: "console-operations", replaceIn: "WP-36" };
    const texts = { es: { ...TEXTS, "og-card": TEXT }, en: { ...TEXTS, "og-card": TEXT } };
    expect(landingProblems(input({ manifest: { version: 2, entries: [...(input().manifest as { entries: unknown[] }).entries, placeholder] }, mediaTexts: texts }))).toContain("og-card: never a placeholder in the hero or as og-card");
  });

  it("asks for the component a render names and for the texts of every picture in both languages", () => {
    expect(landingProblems(input({ componentSource: () => "export function Other() {}" }))).toContain("tour-reader: packages/web/src/views/landing/SceneVisuals.tsx has no component ReaderCard");
    expect(landingProblems(input({ componentSource: () => undefined }))).toContain("tour-reader: component file packages/web/src/views/landing/SceneVisuals.tsx does not exist");
    expect(landingProblems(input({ mediaTexts: { es: TEXTS, en: { "tour-reader": TEXT } } }))).toContain("console-dossier-reading: no alt text or caption in en");
  });

  it("reports each render with its capture's state for landing:renders", () => {
    const manifest = { version: 2 as const, entries: [capture("console-dossier-reading", "local"), render("tour-reader", "console-dossier-reading")] };
    expect(rendersReport(manifest, { "tour-reader": record("console-dossier-reading", "swap"), "tour-eta": record("console-clock", "swap") })).toEqual([
      { id: "tour-reader", replacedBy: "console-dossier-reading", capture: "capture (local)", policy: "swap", until: "SC-24 en verde en poc" },
      { id: "tour-eta", replacedBy: "console-clock", capture: "missing", policy: "swap", until: "SC-24 en verde en poc" },
    ]);
  });
});
