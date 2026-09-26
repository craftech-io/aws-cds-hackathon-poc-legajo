// The whole seed in memory (docs/seed-spec.md §1): PDFs and the reader's catalog, the worlds in
// template form, the instances of the demo worlds and of `GLOBAL#firm-qa` at epoch 1 with the seed's
// test key (the table files), the rows every world shares, the metrics batch and the QA fixture.
import { groundTruthItems } from "@legajo/reader-mock/catalog";
import { QA_CLOCK, SEED_REAL_NOW, type SeedTableName, type WorldTableName } from "../lib/constants";
import { instantiate, keyed, type SeedItem } from "../lib/items";
import { FIRMS, BROKERS } from "./catalog-parties";
import type { DocVersion } from "./documents";
import { firmRows } from "./firm-rows";
import { batchEntries, type BatchEntry } from "./metrics";
import { buildPdfs, type PdfArtifact } from "./pdfs";
import { qaFixtureAggregates } from "./qa-fixture";
import { referenceItems } from "./reference";
import { buildWorld, templateFile, type BuiltWorld, type PdfCatalog } from "./worlds";
import { deltaWorld, judgeWorld, modelsWorlds, norteWorld, qaMinWorld } from "./world-context";

export interface SeedBundle {
  readonly tables: Record<SeedTableName, SeedItem[]>;
  readonly pdfs: readonly PdfArtifact[];
  readonly templates: Readonly<Record<string, Record<string, unknown>>>;
  readonly batch: readonly BatchEntry[];
  readonly qaFixture: Record<string, unknown>;
}

function pdfCatalog(pdfs: readonly PdfArtifact[]): PdfCatalog {
  const versionsByModel = new Map<string, DocVersion[]>();
  const files = new Map<string, { sha256: string; sizeBytes: number }>();
  for (const pdf of pdfs) {
    if (pdf.version === undefined) continue;
    const list = versionsByModel.get(pdf.version.truth.spec.number) ?? [];
    list.push(pdf.version);
    versionsByModel.set(pdf.version.truth.spec.number, list);
    files.set(pdf.version.docId, { sha256: pdf.sha256, sizeBytes: pdf.bytes.byteLength });
  }
  return { versionsByModel, files };
}

/** Instance items of a world at epoch 1: the operations first, so the threads of its messages exist. */
async function instanceOf(built: BuiltWorld): Promise<Record<WorldTableName, SeedItem[]>> {
  const threads = new Map<string, string>();
  const options = { worldEpoch: 1, threads };
  const { items } = built;
  return {
    Operations: await instantiate(items.Operations, options),
    Firms: await instantiate(items.Firms, options),
    Parties: await instantiate(items.Parties, options),
    Conversations: await instantiate(items.Conversations, options),
    AuditLog: await instantiate(items.AuditLog, options),
    LegajoMetrics: await instantiate(items.LegajoMetrics, options),
    Platform: items.Platform,
  };
}

/** Reader catalog rows: every known PDF by hash and by embedded id, stamped like the rest of the seed. */
function catalogItems(pdfs: readonly PdfArtifact[]): SeedItem[] {
  return pdfs.flatMap((pdf) => {
    if (pdf.version === undefined) return [];
    const stamp = { createdAt: SEED_REAL_NOW, updatedAt: SEED_REAL_NOW };
    return groundTruthItems({ sha256: pdf.sha256, docId: pdf.version.docId, reading: pdf.version.reading }, stamp).map((item) => ({ ...item, version: 1, synthetic: true }) as SeedItem);
  });
}

export async function buildSeed(): Promise<SeedBundle> {
  const pdfs = buildPdfs();
  const catalog = pdfCatalog(pdfs);
  const delta = buildWorld(deltaWorld(), catalog);
  const norte = buildWorld(norteWorld(), catalog);
  const judge = buildWorld(judgeWorld(), catalog);
  const qaMin = buildWorld(qaMinWorld(), catalog);
  const models = modelsWorlds().map((world) => buildWorld(world, catalog));
  const templates = {
    "demo-firm-delta": templateFile([delta]),
    "demo-firm-norte": templateFile([norte]),
    "qa-min": templateFile([qaMin]),
    judge: templateFile([judge]),
    models: templateFile(models),
  };
  const instances = await Promise.all([delta, norte, qaMin].map(instanceOf));
  const shared = ["firm-qa", "firm-sim"].flatMap((firmId) => {
    const firm = FIRMS.find((candidate) => candidate.firmId === firmId);
    return firm === undefined ? [] : firmRows(firm, BROKERS.filter((broker) => broker.firmId === firmId)).map(keyed);
  });
  const reference = referenceItems().map(keyed);
  const pick = (table: WorldTableName) => instances.flatMap((instance) => instance[table]);
  const tables: Record<SeedTableName, SeedItem[]> = {
    Firms: [...pick("Firms"), ...shared],
    Parties: pick("Parties"),
    Operations: pick("Operations"),
    Conversations: pick("Conversations"),
    AuditLog: pick("AuditLog"),
    Reference: reference,
    LegajoMetrics: pick("LegajoMetrics"),
    ReaderCatalog: catalogItems(pdfs),
    Platform: pick("Platform"),
  };
  const qa = instances[2];
  const settings = shared.find((item) => item.entity === "FirmSettings" && item.firmId === "firm-qa");
  if (qa === undefined || settings === undefined) throw new Error("the QA world and its firm's settings are part of the seed");
  const aggregates = qaFixtureAggregates({ rows: qa.LegajoMetrics, operations: qa.Operations, settings, decisions: qa.AuditLog, rateCard: reference.filter((item) => item.entity === "RateCard") });
  const qaFixture = { clockId: QA_CLOCK, template: "qa-min", operations: qa.LegajoMetrics.map((row) => String(row.operationId)), aggregates };
  return { tables, pdfs, templates, batch: batchEntries(), qaFixture };
}
