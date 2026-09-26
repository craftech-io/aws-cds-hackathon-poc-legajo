// Shape of public/landing/manifest.json, the list of the landing's pictures: renders of real pages
// made by scripts/landing/render-visuals.ts and console captures taken by
// scripts/landing/capture-console.ts, in `poc` with the synthetic `judge-test` account after a real run
// or on the local UI server, which the landing labels "entorno local, agente guionado"
// (docs/design-brief.md §7.2). Pure zod, no React: the landing and the scripts share it. A picture's
// alt text and caption live in copy, in both languages; the manifest only says what the file is.
import { z } from "zod";

/** Every picture the landing knows, in gallery order: the console first, then the upload page. */
export const MEDIA_IDS = [
  "console-operations",
  "console-dossier",
  "console-simulator",
  "console-mailbox",
  "console-clock",
  "console-metrics",
  "console-audit",
  "upload-page",
  "upload-done",
] as const;
export const MediaId = z.enum(MEDIA_IDS);
export type MediaId = z.infer<typeof MediaId>;

/** Pictures of the console, taken by scripts/landing/capture-console.ts from scripts/landing/captures.json. */
export const CONSOLE_CAPTURE_IDS: readonly MediaId[] = MEDIA_IDS.filter((id) => id.startsWith("console-"));

/** Where a console capture was taken: the deployed stage after a real run, or the local UI server. */
export const CaptureOrigin = z.enum(["poc", "local"]);
export type CaptureOrigin = z.infer<typeof CaptureOrigin>;

export const MediaItem = z
  .object({
    file: z.string().regex(/^\/landing\/[a-z0-9-]+\.(?:png|jpg)$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    status: z.enum(["render", "placeholder", "capture"]),
    origin: CaptureOrigin.optional(),
  })
  .strict()
  .refine((item) => (item.status === "capture") === (item.origin !== undefined), { message: "a capture says where it was taken, and only a capture does" });
export type MediaItem = z.infer<typeof MediaItem>;

export const LandingManifest = z
  .object({
    version: z.literal(1),
    video: z.object({ src: z.string().startsWith("/landing/"), poster: z.string().startsWith("/landing/").optional(), caption: z.string().optional() }).strict().nullable(),
    media: z.partialRecord(MediaId, MediaItem),
  })
  .strict();
export type LandingManifest = z.infer<typeof LandingManifest>;

/** Ids of the manifest's pictures, in gallery order. */
export function mediaIdsIn(manifest: LandingManifest): MediaId[] {
  return MEDIA_IDS.filter((id) => manifest.media[id] !== undefined);
}

/** The manifest with `item` under `id`, every picture kept in gallery order (what the scripts write). */
export function withMedia(manifest: LandingManifest, id: MediaId, item: MediaItem): LandingManifest {
  const media: Partial<Record<MediaId, MediaItem>> = {};
  for (const known of MEDIA_IDS) {
    const value = known === id ? MediaItem.parse(item) : manifest.media[known];
    if (value !== undefined) media[known] = value;
  }
  return { ...manifest, media };
}
