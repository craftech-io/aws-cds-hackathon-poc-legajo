// Fixed parameters of the synthetic seed (docs/seed-spec.md): the PRNG seed, the generator version,
// the seed's own real clock, the simulated start of every demo world and where the artifacts live.
// Changing SEED or GENERATOR_VERSION regenerates everything (and the reader catalog's hashes).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TableName } from "@legajo/bff/lib/resource";
import { QA_GLOBAL_CLOCK_ID, globalClockId } from "@legajo/shared";

export const APP = "aws-cds-hackathon-poc-legajo";
export const SEED = 20260925;
export const GENERATOR_VERSION = "1.0.0";

/** Real instant every seeded item is stamped with (`createdAt`, `updatedAt`, `generatedAt`). */
export const SEED_REAL_NOW = "2026-09-25T12:00:00.000Z";

/** Wednesday 14/10 10:30 in Buenos Aires, after the 10:00 milestones of that day (§3). */
export const START_AT_SIM = "2026-10-14T10:30:00-03:00";

/** Last event of 4471 the judge's tour reaches with "Avanzar al próximo evento" (§3, invariant 21). */
export const TOUR_WINDOW_END_SIM = "2026-10-16T09:00:00-03:00";
export const TOUR_OPERATION_ID = "op-4471";

/** Date of the registered web searches of `Reference/NAMECHECK` and of the holiday check. */
export const CHECKED_AT = "2026-09-26";

export const DELTA_FIRM = "firm-delta";
export const NORTE_FIRM = "firm-norte";
export const DELTA_CLOCK = globalClockId(DELTA_FIRM);
export const NORTE_CLOCK = globalClockId(NORTE_FIRM);
export const QA_CLOCK = QA_GLOBAL_CLOCK_ID;

/** Placeholders of the `judge` template: the world factory writes `nn` of the judge instead of `00`. */
export const JUDGE_TEMPLATE_FIRM = "firm-judge-00";
export const JUDGE_TEMPLATE_CLOCK = `JUDGE#${JUDGE_TEMPLATE_FIRM}`;
export const JUDGE_TEMPLATE_TAG = "j00";

/** The seeded tables, one JSON file each (`scripts/seed/data/<Tabla>.json`, §1). */
export const SEED_TABLES = ["Firms", "Parties", "Operations", "Conversations", "AuditLog", "Reference", "LegajoMetrics", "ReaderCatalog", "Platform"] as const satisfies readonly TableName[];
export type SeedTableName = (typeof SEED_TABLES)[number];

/** Tables whose items are entities of the domain (packages/bff/src/domain/registry.ts). */
export const DOMAIN_TABLES = ["Firms", "Parties", "Operations", "Conversations", "AuditLog", "Reference", "LegajoMetrics"] as const satisfies readonly SeedTableName[];
export type DomainTableName = (typeof DOMAIN_TABLES)[number];

/** Tables a world template carries (the world factory writes them per world). */
export const WORLD_TABLES = ["Firms", "Parties", "Operations", "Conversations", "AuditLog", "LegajoMetrics", "Platform"] as const satisfies readonly SeedTableName[];
export type WorldTableName = (typeof WORLD_TABLES)[number];

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const SEED_ROOT = join(LIB_DIR, "..");
export const REPO_ROOT = join(SEED_ROOT, "..", "..");

export interface SeedPaths {
  readonly root: string;
  readonly data: string;
  readonly pdfs: string;
  readonly worlds: string;
  readonly metrics: string;
  readonly manifest: string;
}

/** Where a seed lives: the committed one (`scripts/seed`) or a scratch copy of the determinism test. */
export function seedPaths(root: string = SEED_ROOT): SeedPaths {
  const data = join(root, "data");
  return { root, data, pdfs: join(root, "pdfs"), worlds: join(data, "worlds"), metrics: join(data, "metrics"), manifest: join(data, "manifest.json") };
}

export const BATCH_INPUTS_FILE = "batch-inputs.jsonl";
export const QA_FIXTURE_FILE = "qa-fixture.json";
