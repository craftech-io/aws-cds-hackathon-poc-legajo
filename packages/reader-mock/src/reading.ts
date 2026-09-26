// Turns what the catalog knows into a `Reading` of the contract. Nothing is computed from the PDF:
// a match by SHA-256 returns the ground truth as written, a match by the embedded id returns it with
// 0.05 less confidence, and no match is UNRECOGNIZED (ADR-0003: the broker classifies it).
import { IdempotencyKey, Sha256Hex, type Reading } from "@legajo/reader-contract";
import type { GroundTruthReading } from "./catalog";

export const READER_MOCK_VERSION = "reader-mock-1.0.0";

/** Confidence lost when the file is not the catalogued one but carries its embedded id. */
export const EMBEDDED_ID_CONFIDENCE_PENALTY = 0.05;

const READING_ID_PREFIX = "rdg-";
const SHA_LENGTH = 64;

/**
 * `rdg-<sha256>-<idempotencyKey>`: deterministic per (key, file), so a retried call gets the same id,
 * and reversible, so `GET /v1/readings/{readingId}` finds the cached reading without another index.
 */
export function readingIdOf(idempotencyKey: string, sha256: string): string {
  return `${READING_ID_PREFIX}${Sha256Hex.parse(sha256)}-${IdempotencyKey.parse(idempotencyKey)}`;
}

export function parseReadingId(readingId: string): { idempotencyKey: string; sha256: string } | undefined {
  if (!readingId.startsWith(READING_ID_PREFIX)) return undefined;
  const sha256 = readingId.slice(READING_ID_PREFIX.length, READING_ID_PREFIX.length + SHA_LENGTH);
  const separator = readingId.charAt(READING_ID_PREFIX.length + SHA_LENGTH);
  const idempotencyKey = readingId.slice(READING_ID_PREFIX.length + SHA_LENGTH + 1);
  if (separator !== "-" || !Sha256Hex.safeParse(sha256).success || !IdempotencyKey.safeParse(idempotencyKey).success) return undefined;
  return { idempotencyKey, sha256 };
}

export type Match = { readonly by: "SHA256" | "EMBEDDED_ID"; readonly truth: GroundTruthReading } | { readonly by: "NONE" };

function roundConfidence(value: number): number {
  return Math.max(0, Math.round(value * 10_000) / 10_000);
}

export function composeReading(readingId: string, match: Match): Reading {
  if (match.by === "NONE") return { readingId, status: "UNRECOGNIZED", matchedBy: "NONE", readerVersion: READER_MOCK_VERSION };
  const confidence = match.by === "EMBEDDED_ID" ? roundConfidence(match.truth.confidence - EMBEDDED_ID_CONFIDENCE_PENALTY) : match.truth.confidence;
  return { readingId, ...match.truth, matchedBy: match.by, confidence, readerVersion: READER_MOCK_VERSION };
}
