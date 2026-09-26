// Items of the mock's own table, `ReaderCatalog` (docs/architecture.md §5), and the port the mock
// reads them through:
//
//   SHA#<sha256>              · READING         ground truth of a synthetic PDF, by its file hash
//   DOCID#<LegajoDocId>       · READING         the same ground truth, by the id embedded in the PDF
//   CONFIG                    · FAULTS#<clockId> faults of one QA world (written by the QaDriver)
//   IDEMP#<key>#<sha256>      · META            a reading already answered, for 48 h
//
// The seed generator (scripts/seed, WP-08) builds the ground-truth items with `groundTruthItems`
// and the QaDriver (`reader.setFaults`) the fault item with `faultItem`, so the three writers and
// the mock agree on one shape. The mock computes nothing: every field and observation of a reading
// is written in the ground truth (docs/seed-spec.md §9).
import { z } from "zod";
import { DocType, SyntheticDocId, clockScopeOf, parseClockId } from "@legajo/shared";
import { READER_LIMITS, Reading, Sha256Hex } from "@legajo/reader-contract";

/** What the reader knows about a synthetic PDF: a reading without the per-call fields. */
export const GroundTruthReading = Reading.omit({ readingId: true, matchedBy: true, readerVersion: true }).extend({
  status: z.literal("RECOGNIZED"),
  docType: DocType,
  confidence: z.number().min(0).max(1),
});
export type GroundTruthReading = z.infer<typeof GroundTruthReading>;

const SeedStamp = {
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  version: z.int().optional(),
  synthetic: z.literal(true).optional(),
};

export const GroundTruthItem = z
  .object({
    PK: z.string(),
    SK: z.literal("READING"),
    entity: z.literal("GroundTruthReading"),
    sha256: Sha256Hex,
    docId: SyntheticDocId,
    reading: GroundTruthReading,
    ...SeedStamp,
  })
  .refine((item) => item.PK === catalogKeys.sha(item.sha256) || item.PK === catalogKeys.docId(item.docId), "PK must be SHA#<sha256> or DOCID#<docId> of the item");
export type GroundTruthItem = z.infer<typeof GroundTruthItem>;

export const FaultMode = z.enum(["NONE", "LATENCY", "ERROR_503", "TIMEOUT", "ERROR_429"]);
export type FaultMode = z.infer<typeof FaultMode>;

/** Faults of one QA world: `mode` applies to a share `rate` of the calls until `until` (real time). */
export const FaultConfig = z.object({
  mode: FaultMode,
  rate: z.number().min(0).max(1).default(1),
  until: z.iso.datetime({ offset: true }),
});
export type FaultConfig = z.infer<typeof FaultConfig>;
export type FaultConfigInput = z.input<typeof FaultConfig>;

/** Only the clocks of the scenario runner carry faults (never GLOBAL#* nor JUDGE#*). */
export const FaultClockId = z.string().refine((value) => parseClockId(value)?.scope === "QA", "faults apply only to qa-* clocks");

export const FaultItem = FaultConfig.extend({
  PK: z.literal("CONFIG"),
  SK: z.string(),
  entity: z.literal("FaultConfig"),
  clockId: FaultClockId,
  createdAt: z.string(),
  expiresAt: z.int(),
}).refine((item) => item.SK === catalogKeys.faults(item.clockId), "SK must be FAULTS#<clockId> of the item");
export type FaultItem = z.infer<typeof FaultItem>;

export const IdempotencyItem = z.object({
  PK: z.string(),
  SK: z.literal("META"),
  entity: z.literal("Idempotency"),
  idempotencyKey: z.string(),
  sha256: Sha256Hex,
  reading: Reading,
  createdAt: z.string(),
  expiresAt: z.int(),
});
export type IdempotencyItem = z.infer<typeof IdempotencyItem>;

export const catalogKeys = {
  sha: (sha256: string): string => `SHA#${sha256}`,
  docId: (docId: string): string => `DOCID#${docId}`,
  faultsPk: "CONFIG",
  faults: (clockId: string): string => `FAULTS#${clockId}`,
  idempotency: (key: string, sha256: string): string => `IDEMP#${key}#${sha256}`,
} as const;

export type GroundTruthKey = { readonly sha256: string } | { readonly docId: string };

/** Port of the `ReaderCatalog` table (DynamoDB in the stage, memory in tests and local flows). */
export interface CatalogStore {
  groundTruth(key: GroundTruthKey): Promise<GroundTruthReading | undefined>;
  faults(clockId: string): Promise<FaultItem | undefined>;
  /** A cached reading, or undefined when absent or past its `expiresAt`. */
  cachedReading(idempotencyKey: string, sha256: string, now: Date): Promise<IdempotencyItem | undefined>;
  /** Stores the reading unless one is already cached for the pair, and returns the one that stays. */
  cacheReading(item: IdempotencyItem): Promise<IdempotencyItem>;
}

export interface Stamp {
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/** The two ground-truth items of a synthetic PDF (by hash and by embedded id), as the seed writes them. */
export function groundTruthItems(input: { sha256: string; docId: string; reading: GroundTruthReading }, stamp: Stamp = {}): [GroundTruthItem, GroundTruthItem] {
  const base = {
    SK: "READING" as const,
    entity: "GroundTruthReading" as const,
    sha256: Sha256Hex.parse(input.sha256),
    docId: SyntheticDocId.parse(input.docId),
    reading: GroundTruthReading.parse(input.reading),
    ...stamp,
  };
  return [GroundTruthItem.parse({ PK: catalogKeys.sha(base.sha256), ...base }), GroundTruthItem.parse({ PK: catalogKeys.docId(base.docId), ...base })];
}

function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

const IDEMPOTENCY_TTL_SECONDS = READER_LIMITS.idempotencyTtlHours * 3600;
/** Fault rows expire with the QA world that wrote them (docs/architecture.md §5: "Fallas e idempotencia 48 h"). */
const FAULT_TTL_SECONDS = 48 * 3600;

/** The `FAULTS#<clockId>` item of `reader.setFaults`; throws for any clock that is not `qa-*`. */
export function faultItem(clockId: string, config: FaultConfigInput, now: Date): FaultItem {
  if (clockScopeOf(clockId) !== "QA") throw new RangeError(`faults apply only to qa-* clocks, not "${clockId}"`);
  const parsed = FaultConfig.parse(config);
  return FaultItem.parse({
    PK: catalogKeys.faultsPk,
    SK: catalogKeys.faults(clockId),
    entity: "FaultConfig",
    clockId,
    ...parsed,
    createdAt: now.toISOString(),
    expiresAt: epochSeconds(now) + FAULT_TTL_SECONDS,
  });
}

export function idempotencyItem(idempotencyKey: string, sha256: string, reading: Reading, now: Date): IdempotencyItem {
  return {
    PK: catalogKeys.idempotency(idempotencyKey, sha256),
    SK: "META",
    entity: "Idempotency",
    idempotencyKey,
    sha256,
    reading,
    createdAt: now.toISOString(),
    expiresAt: epochSeconds(now) + IDEMPOTENCY_TTL_SECONDS,
  };
}

/** DynamoDB's TTL deletes lazily: an item past `expiresAt` is treated as absent. */
export function isLive(item: { readonly expiresAt: number }, now: Date): boolean {
  return item.expiresAt > epochSeconds(now);
}
