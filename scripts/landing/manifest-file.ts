// public/landing/manifest.json on disk, for the scripts that make the landing's pictures: each one
// writes its PNG next to the manifest and records it there (size, render or capture, and where a
// capture was taken), keeping the rest of the manifest as it was, in gallery order. The shape is the
// landing's own (packages/web/src/views/landing/manifest.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LandingManifest, type MediaId, type MediaItem, withMedia } from "../../packages/web/src/views/landing/manifest";

export const WEB_DIR = join(import.meta.dirname, "../../packages/web");
export const LANDING_DIR = join(WEB_DIR, "public/landing");
export const MANIFEST_PATH = join(LANDING_DIR, "manifest.json");

/** Largest picture the landing takes; a bigger one slows the public page for no gain. */
export const MAX_PICTURE_BYTES = 400 * 1024;

export function readManifest(path: string = MANIFEST_PATH): LandingManifest {
  return LandingManifest.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Writes `<id>.png` into `dir` after checking its weight; returns its path inside public/. */
export function writePicture(dir: string, id: MediaId, picture: Buffer): string {
  if (picture.byteLength > MAX_PICTURE_BYTES) throw new Error(`${id}: ${Math.round(picture.byteLength / 1024)} KB, over the ${MAX_PICTURE_BYTES / 1024} KB budget`);
  writeFileSync(join(dir, `${id}.png`), picture);
  return `/landing/${id}.png`;
}

/** Records a picture written into public/landing in the manifest. */
export function recordInManifest(id: MediaId, item: MediaItem, path: string = MANIFEST_PATH): void {
  writeFileSync(path, `${JSON.stringify(withMedia(readManifest(path), id, item), null, 2)}\n`);
}
