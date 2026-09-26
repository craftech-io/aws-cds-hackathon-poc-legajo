// Shapes of the seed's files (docs/seed-spec.md §1), shared by the generator, `seed:validate`, the
// seed's tests and the loader (WP-31): one JSON per table, the world templates, the metrics fixture
// and the manifest. Reading a seed from disk goes through `readSeed`, never through ad-hoc parsing.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { WorldTemplateName } from "@legajo/shared";
import { BATCH_INPUTS_FILE, QA_FIXTURE_FILE, SEED_TABLES, WORLD_TABLES, seedPaths, type SeedPaths, type SeedTableName } from "./constants";
import type { SeedItem } from "./items";

const Item = z.record(z.string(), z.unknown()).refine((item) => typeof item.entity === "string", "every item names its entity") as unknown as z.ZodType<SeedItem>;

export const TableFile = z.object({
  table: z.enum(SEED_TABLES),
  generatedAt: z.string(),
  seed: z.number().int(),
  count: z.number().int().nonnegative(),
  items: z.array(Item),
});
export type TableFile = z.infer<typeof TableFile>;

const WorldItems = z.object(Object.fromEntries(WORLD_TABLES.map((table) => [table, z.array(Item)])) as Record<(typeof WORLD_TABLES)[number], z.ZodArray<typeof Item>>);

export const WorldTemplateFile = z.object({
  template: WorldTemplateName,
  generatorVersion: z.string(),
  seed: z.number().int(),
  startAtSim: z.string(),
  /** Firm and clock the items are written for (absent in `models`, whose operations name theirs). */
  source: z.object({ firmId: z.string(), clockId: z.string(), firmKind: z.string() }).optional(),
  derived: z.object({ fields: z.record(z.string(), z.array(z.string())), threadAddressPlaceholder: z.string(), worldEpoch: z.string(), keys: z.string() }),
  placeholders: z.record(z.string(), z.string()).optional(),
  tour: z.object({ operationId: z.string(), operationNumber: z.string(), windowStartSim: z.string(), windowEndSim: z.string() }).optional(),
  operations: z.array(z.object({ operationId: z.string(), operationNumber: z.string(), model: z.string(), importerId: z.string(), supplierId: z.string(), dossierStatus: z.string(), firmId: z.string(), clockId: z.string() })),
  altContacts: z.array(z.object({ supplierId: z.string(), email: z.string() })),
  items: WorldItems,
});
export type WorldTemplateFile = z.infer<typeof WorldTemplateFile>;

export const QaFixtureFile = z.object({
  clockId: z.string(),
  template: z.literal("qa-min"),
  operations: z.array(z.string()),
  aggregates: z.record(z.string(), z.number()),
});
export type QaFixtureFile = z.infer<typeof QaFixtureFile>;

export const Manifest = z.object({
  app: z.string(),
  generatorVersion: z.string(),
  seed: z.number().int(),
  clock: z.object({ generatedAt: z.string(), startAtSim: z.string() }),
  tables: z.record(z.string(), z.object({ count: z.number().int(), sha256: z.string() })),
  worlds: z.record(z.string(), z.object({ sha256: z.string() })),
  pdfs: z.object({ count: z.number().int(), files: z.record(z.string(), z.string()) }),
  readerCatalog: z.object({ readings: z.number().int(), items: z.number().int(), unknown: z.number().int() }),
  metrics: z.object({ qaFixture: z.object({ sha256: z.string(), aggregates: z.record(z.string(), z.number()) }), batch: z.object({ sha256: z.string(), counts: z.record(z.string(), z.number()) }) }),
  validation: z.object({ status: z.enum(["PASS", "FAIL"]), errors: z.array(z.string()), warnings: z.array(z.string()) }),
});
export type Manifest = z.infer<typeof Manifest>;

export interface SeedOnDisk {
  readonly paths: SeedPaths;
  readonly tables: Record<SeedTableName, TableFile>;
  readonly templates: Partial<Record<WorldTemplateName, WorldTemplateFile>>;
  readonly batch: unknown[];
  readonly qaFixture?: QaFixtureFile;
  /** PDFs by path relative to `pdfs/`. */
  readonly pdfs: Map<string, Uint8Array>;
  readonly manifest?: unknown;
  /** Raw bytes of every file of `data/` (checksums), by path relative to `data/`. */
  readonly dataFiles: Map<string, Buffer>;
}

function filesUnder(dir: string, root: string = dir, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) filesUnder(path, root, out);
    else out.push(relative(root, path));
  }
  return out;
}

/** Reads a whole seed; a malformed file throws with its path. */
export function readSeed(root?: string): SeedOnDisk {
  const paths = seedPaths(root);
  const dataFiles = new Map(filesUnder(paths.data).map((path) => [path, readFileSync(join(paths.data, path))]));
  const json = (path: string): unknown => {
    const bytes = dataFiles.get(path);
    if (bytes === undefined) throw new Error(`missing scripts/seed/data/${path}`);
    return JSON.parse(bytes.toString("utf8")) as unknown;
  };
  const tables = Object.fromEntries(SEED_TABLES.map((table) => [table, TableFile.parse(json(`${table}.json`))])) as Record<SeedTableName, TableFile>;
  const templates: Partial<Record<WorldTemplateName, WorldTemplateFile>> = {};
  for (const name of WorldTemplateName.options) if (dataFiles.has(`worlds/${name}.json`)) templates[name] = WorldTemplateFile.parse(json(`worlds/${name}.json`));
  const batchText = dataFiles.get(`metrics/${BATCH_INPUTS_FILE}`)?.toString("utf8") ?? "";
  const batch = batchText.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
  const qaFixture = dataFiles.has(`metrics/${QA_FIXTURE_FILE}`) ? QaFixtureFile.parse(json(`metrics/${QA_FIXTURE_FILE}`)) : undefined;
  const pdfs = new Map(filesUnder(paths.pdfs).map((path) => [path, new Uint8Array(readFileSync(join(paths.pdfs, path)))]));
  const manifest = dataFiles.has("manifest.json") ? json("manifest.json") : undefined;
  return { paths, tables, templates, batch, ...(qaFixture === undefined ? {} : { qaFixture }), pdfs, ...(manifest === undefined ? {} : { manifest }), dataFiles };
}
