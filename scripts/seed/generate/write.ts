// Writes a seed bundle to disk (docs/seed-spec.md §1): canonical JSON, one file per table, the world
// templates, the batch inputs, the QA fixture, the PDFs, and last the manifest with the checksum of
// every file and the result of the validation that ran over what was written.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BATCH_INPUTS_FILE, GENERATOR_VERSION, PRODUCT, QA_FIXTURE_FILE, SEED, SEED_REAL_NOW, SEED_TABLES, START_AT_SIM, type SeedPaths } from "../lib/constants";
import { sha256Hex, stableJsonLines, stableStringify } from "../lib/json";
import { batchCounts } from "./metrics";
import type { SeedBundle } from "./seed";

function write(path: string, content: string | Uint8Array): Buffer {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  writeFileSync(path, bytes);
  return bytes;
}

export interface WrittenSeed {
  /** SHA-256 of every file written, by path relative to `data/` or to `pdfs/`. */
  readonly tables: Record<string, { count: number; sha256: string }>;
  readonly worlds: Record<string, { sha256: string }>;
  readonly pdfs: Record<string, string>;
  readonly batchSha256: string;
  readonly qaFixtureSha256: string;
}

/** Replaces `data/` and `pdfs/` with the bundle (everything there is generated). */
export function writeSeed(bundle: SeedBundle, paths: SeedPaths): WrittenSeed {
  rmSync(paths.data, { recursive: true, force: true });
  rmSync(paths.pdfs, { recursive: true, force: true });
  const tables: WrittenSeed["tables"] = {};
  for (const table of SEED_TABLES) {
    const items = bundle.tables[table];
    const bytes = write(join(paths.data, `${table}.json`), stableStringify({ table, generatedAt: SEED_REAL_NOW, seed: SEED, count: items.length, items }));
    tables[table] = { count: items.length, sha256: sha256Hex(bytes) };
  }
  const worlds: WrittenSeed["worlds"] = {};
  for (const [name, template] of Object.entries(bundle.templates).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    worlds[name] = { sha256: sha256Hex(write(join(paths.worlds, `${name}.json`), stableStringify(template))) };
  }
  const batchSha256 = sha256Hex(write(join(paths.metrics, BATCH_INPUTS_FILE), stableJsonLines(bundle.batch)));
  const qaFixtureSha256 = sha256Hex(write(join(paths.metrics, QA_FIXTURE_FILE), stableStringify(bundle.qaFixture)));
  const pdfs: WrittenSeed["pdfs"] = {};
  for (const pdf of bundle.pdfs) {
    write(join(paths.pdfs, pdf.path), pdf.bytes);
    pdfs[pdf.path] = pdf.sha256;
  }
  return { tables, worlds, pdfs, batchSha256, qaFixtureSha256 };
}

export interface ValidationSummary {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export function writeManifest(bundle: SeedBundle, written: WrittenSeed, validation: ValidationSummary, paths: SeedPaths): void {
  const readings = bundle.pdfs.filter((pdf) => pdf.version !== undefined).length;
  const manifest = {
    product: PRODUCT,
    generatorVersion: GENERATOR_VERSION,
    seed: SEED,
    clock: { generatedAt: SEED_REAL_NOW, startAtSim: START_AT_SIM },
    tables: written.tables,
    worlds: written.worlds,
    pdfs: { count: bundle.pdfs.length, files: written.pdfs },
    readerCatalog: { readings, items: bundle.tables.ReaderCatalog.length, unknown: bundle.pdfs.length - readings },
    metrics: {
      qaFixture: { sha256: written.qaFixtureSha256, aggregates: bundle.qaFixture.aggregates },
      batch: { sha256: written.batchSha256, counts: batchCounts(bundle.batch) },
    },
    validation: { status: validation.errors.length === 0 ? "PASS" : "FAIL", errors: [...validation.errors], warnings: [...validation.warnings] },
  };
  write(paths.manifest, stableStringify(manifest));
}
