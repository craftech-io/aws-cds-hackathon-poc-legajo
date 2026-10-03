// What `seed:load` writes, from the seed on disk (docs/seed-spec.md §1 and §16), without touching AWS:
//
//   fingerprint     SHA-256 of the manifest's bytes and of the overrides in force: the same fingerprint
//                   twice is a no-op unless `--force`
//   static rows     the rows that belong to no demo world: the firm rows of `firm-qa` and `firm-sim`,
//                   `Reference` and `ReaderCatalog` (each demo world's own rows come from its template,
//                   written by the world factory)
//   bucket objects  `Seed/pdfs/<templateOperation>/<docType>-v<n>.pdf`, `Seed/pdfs/unknown/<n>.pdf`, the
//                   reader's catalog, the metrics batch inputs and every world template
//   demo worlds     `demo-firm-delta`, `demo-firm-norte`, `qa-min`, or only the one of `--firm`
import { createHash } from "node:crypto";
import { type WorldTemplateName, seedKeys } from "@legajo/shared";
import type { SeedOverrides } from "@legajo/bff/lib/secrets";
import { DEMO_FIRMS, type DemoTemplate } from "@legajo/bff/worlds/plan";
import { stableStringify } from "../lib/json";
import type { SeedOnDisk } from "../lib/files";
import type { SeedItem } from "../lib/items";

export const DEMO_TEMPLATES = Object.keys(DEMO_FIRMS) as DemoTemplate[];

/** Where the loader records the fingerprint of what it loaded (`Seed/loaded.json`). */
export const LOADED_KEY = "loaded.json";

export interface LoadArgs {
  readonly stage?: string;
  readonly force: boolean;
  readonly firm?: string;
}

export function parseLoadArgs(argv: readonly string[]): LoadArgs {
  let force = false;
  let firm: string | undefined;
  let stage: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--force") force = true;
    else if (flag === "--firm" || flag === "--stage") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new RangeError(`${flag} needs a value`);
      if (flag === "--firm") firm = value;
      else stage = value;
      index += 1;
    } else throw new RangeError(`unknown flag ${String(flag)} (expected --force, --firm <firmId>)`);
  }
  if (firm !== undefined && !Object.values(DEMO_FIRMS).includes(firm)) throw new RangeError(`--firm takes one of ${Object.values(DEMO_FIRMS).join(", ")}`);
  return { force, ...(firm === undefined ? {} : { firm }), ...(stage === undefined ? {} : { stage }) };
}

/** The demo templates a run loads (`--firm` limits it to one firm's world). */
export function demoTemplatesFor(firm: string | undefined): DemoTemplate[] {
  return DEMO_TEMPLATES.filter((template) => firm === undefined || DEMO_FIRMS[template] === firm);
}

export function fingerprintOf(seed: Pick<SeedOnDisk, "dataFiles">, overrides: SeedOverrides): string {
  const manifest = seed.dataFiles.get("manifest.json");
  if (manifest === undefined) throw new Error("scripts/seed/data/manifest.json is missing: run seed:generate");
  return createHash("sha256").update(manifest).update("\u0000").update(stableStringify(overrides)).digest("hex");
}

/** Firms whose rows a demo template writes (their world is the factory's). */
function templateFirms(seed: Pick<SeedOnDisk, "templates">): Set<string> {
  return new Set(DEMO_TEMPLATES.flatMap((name) => {
    const template = seed.templates[name];
    return template !== undefined && template.items.Firms.length > 0 && template.source !== undefined ? [template.source.firmId] : [];
  }));
}

export interface StaticRows {
  readonly Firms: SeedItem[];
  readonly Reference: SeedItem[];
  readonly ReaderCatalog: SeedItem[];
}

/** The rows of no demo world, limited to `--firm` (whose firm rows only) when given. */
export function staticRows(seed: Pick<SeedOnDisk, "tables" | "templates">, firm: string | undefined): StaticRows {
  const owned = templateFirms(seed);
  const firms = seed.tables.Firms.items.filter((item) => item.clockId === undefined && !owned.has(String(item.firmId)) && (firm === undefined || item.firmId === firm));
  return { Firms: firms, Reference: firm === undefined ? seed.tables.Reference.items : [], ReaderCatalog: firm === undefined ? seed.tables.ReaderCatalog.items : [] };
}

export interface SeedObject {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

const encoder = new TextEncoder();
const UNKNOWN_PDF = /^unknown\/unknown-(\d+)\.pdf$/;

/** Every object of the `Seed` bucket, with the keys of `@legajo/shared` `seedKeys`. */
export function seedObjects(seed: Pick<SeedOnDisk, "pdfs" | "templates" | "tables" | "batch" | "dataFiles">): SeedObject[] {
  const objects: SeedObject[] = [];
  for (const [path, body] of seed.pdfs) {
    const unknown = UNKNOWN_PDF.exec(path);
    objects.push({ key: unknown === null ? `pdfs/${path}` : seedKeys.unknownPdf(Number(unknown[1])), body, contentType: "application/pdf" });
  }
  // The templates go as committed, byte for byte (their checksums are the manifest's).
  for (const name of Object.keys(seed.templates) as WorldTemplateName[]) {
    const bytes = seed.dataFiles.get(`worlds/${name}.json`);
    if (bytes !== undefined) objects.push({ key: seedKeys.worldTemplate(name), body: new Uint8Array(bytes), contentType: "application/json" });
  }
  objects.push({ key: seedKeys.readerCatalog, body: encoder.encode(stableStringify(seed.tables.ReaderCatalog.items)), contentType: "application/json" });
  objects.push({ key: seedKeys.batchInputs, body: encoder.encode(seed.batch.map((entry) => JSON.stringify(entry)).join("\n") + "\n"), contentType: "application/x-ndjson" });
  return objects;
}
