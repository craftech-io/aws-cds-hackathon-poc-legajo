// The files of one picture of the landing (ADR-0016 §4, docs/landing-spec.md §5.3): the PNG as
// written by the browser, re-compressed as a palette PNG (the fallback), and AVIF (quality 50) and
// WebP (quality 80) at the widths of its viewport that do not exceed it, all under
// public/landing/<id>/<viewport>[-<width>].<ext>. Returns the `sources` of its manifest entry. The
// same screenshot always gives the same PNG bytes.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";
import { ENCODE_WIDTHS, type ManifestEntry, type MediaId, type Viewport, mediaSrc } from "../../packages/web/src/views/landing/manifest";
import { PUBLIC_DIR, publicPath } from "./manifest-file";

export const AVIF_QUALITY = 50;
export const WEBP_QUALITY = 80;

/** Largest PNG fallback the landing takes; a bigger one slows the public page for no gain. */
export const MAX_PNG_BYTES = 900 * 1024;

function write(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** The palette PNG of a screenshot: deterministic, and what the manifest serves as the fallback. */
export async function fallbackPng(screenshot: Buffer): Promise<Buffer> {
  return sharp(screenshot).png({ palette: true, quality: 90, compressionLevel: 9, effort: 10 }).toBuffer();
}

/** The widths of a viewport that a picture `width` pixels wide can serve without upscaling. */
export function widthsFor(viewport: Viewport, width: number): number[] {
  const fit = ENCODE_WIDTHS[viewport].filter((candidate) => candidate <= width);
  return fit.length > 0 ? fit : [width];
}

export async function encodePicture(id: MediaId, viewport: Viewport, screenshot: Buffer, publicDir: string = PUBLIC_DIR): Promise<ManifestEntry["sources"]> {
  const png = await fallbackPng(screenshot);
  if (png.byteLength > MAX_PNG_BYTES) throw new Error(`${id}/${viewport}: ${Math.round(png.byteLength / 1024)} KB PNG, over the ${MAX_PNG_BYTES / 1024} KB budget`);
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const pngSrc = mediaSrc(id, viewport, "png");
  write(publicPath(pngSrc, publicDir), png);
  const avif: { src: string; w: number }[] = [];
  const webp: { src: string; w: number }[] = [];
  for (const w of widthsFor(viewport, width)) {
    const resized = sharp(screenshot).resize({ width: w, withoutEnlargement: true });
    const avifSrc = mediaSrc(id, viewport, "avif", w);
    write(publicPath(avifSrc, publicDir), await resized.clone().avif({ quality: AVIF_QUALITY }).toBuffer());
    avif.push({ src: avifSrc, w });
    const webpSrc = mediaSrc(id, viewport, "webp", w);
    write(publicPath(webpSrc, publicDir), await resized.clone().webp({ quality: WEBP_QUALITY }).toBuffer());
    webp.push({ src: webpSrc, w });
  }
  return { avif, webp, png: { src: pngSrc, w: width, h: height } };
}
