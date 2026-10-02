// public/landing/manifest.json on disk (version 2, packages/web/src/views/landing/manifest.ts), for the
// scripts that make the landing's pictures: each one writes its files under public/landing/<id>/ and
// records its entry, keeping every other entry as it was, in the manifest's order.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LandingManifest, type ManifestEntry, withEntry } from "../../packages/web/src/views/landing/manifest";

export const WEB_DIR = join(import.meta.dirname, "../../packages/web");
export const PUBLIC_DIR = join(WEB_DIR, "public");
export const LANDING_DIR = join(PUBLIC_DIR, "landing");
export const MANIFEST_PATH = join(LANDING_DIR, "manifest.json");
/** The render list the CTO asked for (ADR-0016 §3), outside public/. */
export const RENDERS_PATH = join(import.meta.dirname, "renders.json");

export function readManifest(path: string = MANIFEST_PATH): LandingManifest {
  if (!existsSync(path)) return { version: 2, entries: [] };
  return LandingManifest.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeManifest(manifest: LandingManifest, path: string = MANIFEST_PATH): void {
  writeFileSync(path, `${JSON.stringify(LandingManifest.parse(manifest), null, 2)}\n`);
}

/** Records one entry (a new picture, or a new version of one) in the manifest on disk. */
export function recordEntry(entry: ManifestEntry, path: string = MANIFEST_PATH): void {
  writeManifest(withEntry(readManifest(path), entry), path);
}

/** Where a manifest `src` lives on disk. */
export function publicPath(src: string, publicDir: string = PUBLIC_DIR): string {
  return join(publicDir, src);
}
