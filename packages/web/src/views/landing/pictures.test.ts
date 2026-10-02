// The pictures the landing ships are whole frames of the product (ADR-0016 §4, FL-129): a capture
// taken while the browser still composited the previous size comes out tiled, its header band
// repeated further down the frame. Every capture of the manifest is decoded and its top band (the
// page's header) has to appear exactly once.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { LandingManifest } from "./manifest";

const PUBLIC_DIR = fileURLToPath(new URL("../../../public", import.meta.url));
const manifest = LandingManifest.parse(JSON.parse(readFileSync(`${PUBLIC_DIR}/landing/manifest.json`, "utf8")));

/** A frame in grey levels, one byte per pixel. */
interface Grey {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Mean absolute difference between the rows from `a` and from `b`, `rows` long, on a sparse grid. */
function bandDistance(frame: Grey, a: number, b: number, rows: number): number {
  let sum = 0;
  let count = 0;
  for (let row = 0; row < rows; row += 2) {
    for (let x = 0; x < frame.width; x += 4) {
      sum += Math.abs((frame.data[(a + row) * frame.width + x] ?? 0) - (frame.data[(b + row) * frame.width + x] ?? 0));
      count += 1;
    }
  }
  return count === 0 ? 255 : sum / count;
}

/** How much the band varies: a flat colour repeats anywhere and proves nothing. */
function bandSpread(frame: Grey, rows: number): number {
  const values = frame.data.subarray(0, rows * frame.width);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length);
}

/**
 * Rows where the frame's top band (its first `band` rows) starts again below itself, within the noise
 * of a palette PNG, or `[]`. A flat band is skipped.
 */
function repeatedTopBand(frame: Grey, band: number, tolerance = 3): number[] {
  if (bandSpread(frame, band) < 12) return [];
  const found: number[] = [];
  for (let start = band; start + band <= frame.height; start += 1) {
    if (bandDistance(frame, 0, start, band) <= tolerance) found.push(start);
  }
  return found;
}

async function decode(src: string): Promise<Grey> {
  const { data, info } = await sharp(`${PUBLIC_DIR}${src}`).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** A synthetic frame: `pattern` rows of stripes, then `filler` rows of one grey, repeated `times`. */
function synthetic(pattern: number, filler: number, times: number): Grey {
  const width = 40;
  const rows: number[] = [];
  for (let copy = 0; copy < times; copy += 1) {
    for (let row = 0; row < pattern; row += 1) rows.push(...Array.from({ length: width }, (_, x) => ((x + row) % 8 < 4 ? 20 : 230)));
    for (let row = 0; row < filler; row += 1) rows.push(...Array.from({ length: width }, () => 128));
  }
  return { data: Uint8Array.from(rows), width, height: rows.length / width };
}

describe("pictures of the landing [FL-129]", () => {
  it("finds a band that repeats and ignores a flat one", () => {
    expect(repeatedTopBand(synthetic(20, 40, 2), 20)).toContain(60);
    expect(repeatedTopBand(synthetic(20, 40, 1), 20)).toEqual([]);
    expect(repeatedTopBand({ data: new Uint8Array(40 * 80).fill(200), width: 40, height: 80 }, 20)).toEqual([]);
  });

  it("ships every capture as one whole frame: its header band never repeats below it", async () => {
    const captures = manifest.entries.filter((entry) => entry.status === "capture");
    expect(captures.length).toBeGreaterThan(0);
    for (const entry of captures) {
      const raw = await decode(entry.sources.png.src);
      const band = Math.min(100 * Math.round(raw.width / (entry.viewport === "mobile" ? 390 : 1440)) || 100, Math.floor(raw.height / 4));
      expect(repeatedTopBand(raw, band), `${entry.id}/${entry.viewport}`).toEqual([]);
    }
  }, 60_000);
});
