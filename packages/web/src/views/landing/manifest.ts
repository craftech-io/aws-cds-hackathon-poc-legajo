// Shape of public/landing/manifest.json, version 2: the single contract of ADR-0016 §3 (repeated by
// docs/landing-spec.md §7.4). One entry per picture and viewport, in one of three states: `capture`
// (the real console or a real page, taken by scripts/landing/capture-console.ts or render-visuals.ts,
// on `poc` or on the local UI server), `render` (a live component of the landing built with the
// product's components and texts, whose PNG is its still frame) or `placeholder`. A render and a
// placeholder name the capture that replaces them and the WP that builds its view. Pure zod, no
// React: the landing, scripts/landing and the tests share it. Alt texts and captions live in copy.
import { z } from "zod";

/** Console captures, in gallery order (docs/landing-spec.md §7.3). */
export const CONSOLE_CAPTURE_IDS = [
  "console-operations",
  "console-simulator",
  "console-mailbox",
  "console-dossier-reading",
  "console-dossier",
  "console-clock",
  "console-escalations",
  "console-mailbox-firm",
  "console-dossier-approval",
  "console-metrics",
  "console-audit",
  "console-tour",
] as const;

/** Real pages served locally (scripts/landing/render-visuals.ts): the upload page and the landing's own card. */
export const PAGE_CAPTURE_IDS = ["upload-page", "upload-done", "og-card"] as const;

/** Live components of the landing (the hero and the eight steps of the tour). */
export const RENDER_IDS = ["hero-conversation", "tour-request", "tour-delegate", "tour-supplier", "tour-reader", "tour-owner", "tour-eta", "tour-escalation", "tour-approval"] as const;

export const MEDIA_IDS = [...CONSOLE_CAPTURE_IDS, ...PAGE_CAPTURE_IDS, ...RENDER_IDS] as const;
export const MediaId = z.enum(MEDIA_IDS);
export type MediaId = z.infer<typeof MediaId>;
export type ConsoleCaptureId = (typeof CONSOLE_CAPTURE_IDS)[number];
export type RenderId = (typeof RENDER_IDS)[number];

/** What the gallery walks: every capture but the landing's own card (G-11). */
export const GALLERY_IDS: readonly MediaId[] = [...CONSOLE_CAPTURE_IDS, "upload-page", "upload-done"];

export const VIEWPORTS = ["desktop", "mobile"] as const;
export const Viewport = z.enum(VIEWPORTS);
export type Viewport = z.infer<typeof Viewport>;

/** Widths `encode.ts` writes per viewport (ADR-0016 §4, docs/landing-spec.md §5.3). */
export const ENCODE_WIDTHS: Readonly<Record<Viewport, readonly number[]>> = { desktop: [480, 960, 1440, 1920], mobile: [390, 780] };

/** Where a capture was taken: the deployed stage after a real run, or the local UI server. */
export const CaptureOrigin = z.enum(["poc", "local"]);
export type CaptureOrigin = z.infer<typeof CaptureOrigin>;

export const SRC_PATTERN = /^\/landing\/([a-z0-9-]+)\/(desktop|mobile)(?:-(\d+))?\.(avif|webp|png)$/;

const Src = z.string().regex(SRC_PATTERN);
const Width = z.number().int().positive();
const Variant = z.object({ src: Src, w: Width }).strict();
const Sources = z.object({ avif: z.array(Variant), webp: z.array(Variant), png: z.object({ src: Src, w: Width, h: Width }).strict() }).strict();
const WorkPackage = z.string().regex(/^WP-\d{2}$/);

const common = { id: MediaId, viewport: Viewport, sources: Sources };

const CaptureEntry = z
  .object({ ...common, status: z.literal("capture"), origin: CaptureOrigin, capturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), commit: z.string().regex(/^[0-9a-f]{7,40}$/) })
  .strict();
const RenderEntry = z
  .object({ ...common, status: z.literal("render"), component: z.string().min(1), textSources: z.array(z.string().min(1)).min(1), replacedBy: MediaId, replaceIn: WorkPackage })
  .strict();
const PlaceholderEntry = z.object({ ...common, status: z.literal("placeholder"), replacedBy: MediaId, replaceIn: WorkPackage }).strict();

export const ManifestEntry = z.discriminatedUnion("status", [CaptureEntry, RenderEntry, PlaceholderEntry]);
export type ManifestEntry = z.infer<typeof ManifestEntry>;

/** Every file of an entry, in the order it names them. */
export function entryFiles(entry: ManifestEntry): string[] {
  return [...entry.sources.avif.map((variant) => variant.src), ...entry.sources.webp.map((variant) => variant.src), entry.sources.png.src];
}

/** Problems of one entry that zod's shape cannot see: every file under its own id and viewport, widths in the names. */
export function entryProblems(entry: ManifestEntry): string[] {
  const problems: string[] = [];
  for (const variant of [...entry.sources.avif, ...entry.sources.webp, { src: entry.sources.png.src, w: undefined }]) {
    const [, id, viewport, width] = SRC_PATTERN.exec(variant.src) ?? [];
    if (id !== entry.id || viewport !== entry.viewport) problems.push(`${entry.id}/${entry.viewport}: ${variant.src} is not under its own id and viewport`);
    if (variant.w !== undefined && width !== String(variant.w)) problems.push(`${entry.id}/${entry.viewport}: ${variant.src} does not carry its width ${variant.w}`);
  }
  if (entry.status !== "capture" && entry.replacedBy === entry.id) problems.push(`${entry.id}: replaced by itself`);
  return problems;
}

export const LandingManifest = z
  .object({ version: z.literal(2), entries: z.array(ManifestEntry) })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const entry of manifest.entries) {
      const key = `${entry.id}/${entry.viewport}`;
      if (seen.has(key)) context.addIssue({ code: "custom", message: `${key} appears twice` });
      seen.add(key);
      for (const message of entryProblems(entry)) context.addIssue({ code: "custom", message });
    }
  });
export type LandingManifest = z.infer<typeof LandingManifest>;

/** The entry of `id` for `viewport`, if the manifest has it. */
export function entryOf(manifest: LandingManifest, id: MediaId, viewport: Viewport): ManifestEntry | undefined {
  return manifest.entries.find((entry) => entry.id === id && entry.viewport === viewport);
}

/** The entry of `id` for the viewport asked for, or for the other one when only that exists. */
export function bestEntry(manifest: LandingManifest, id: MediaId, viewport: Viewport): ManifestEntry | undefined {
  return entryOf(manifest, id, viewport) ?? entryOf(manifest, id, viewport === "desktop" ? "mobile" : "desktop");
}

/** The manifest with `entry` in place of its (id, viewport), every entry kept in `MEDIA_IDS` order (what the scripts write). */
export function withEntry(manifest: LandingManifest, entry: ManifestEntry): LandingManifest {
  const parsed = ManifestEntry.parse(entry);
  const others = manifest.entries.filter((candidate) => candidate.id !== parsed.id || candidate.viewport !== parsed.viewport);
  const rank = (candidate: ManifestEntry) => MEDIA_IDS.indexOf(candidate.id) * VIEWPORTS.length + VIEWPORTS.indexOf(candidate.viewport);
  return { ...manifest, entries: [...others, parsed].sort((a, b) => rank(a) - rank(b)) };
}

/** `/landing/<id>/<viewport>[-<width>].<ext>`, the only shape a file of the manifest may have. */
export function mediaSrc(id: MediaId, viewport: Viewport, ext: "avif" | "webp" | "png", width?: number): string {
  return `/landing/${id}/${viewport}${width === undefined ? "" : `-${width}`}.${ext}`;
}
