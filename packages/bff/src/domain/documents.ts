// `Operations/DOC#…`, `DOC#…#V#…` and `OBS#…` (docs/architecture.md §5): the three documents of a
// dossier, every received version with the reading the external reader returned (ADR-0003: we
// never read a PDF ourselves; this is the persisted copy of the contract's `Reading`), and the
// observations with their responsible party, attempts and status history.
import { z } from "zod";
import { Reading } from "@legajo/reader-contract";
import {
  ClockId,
  ContactId,
  DocStatus,
  DocType,
  DocVersionId,
  DocumentSourceChannel,
  MatrixResponsible,
  MessageId,
  ObservationCode,
  ObservationId,
  ObservationSeverity,
  ObservationStatus,
  OperationId,
  Party,
  docTypeFromShort,
  operationId as operationIdOf,
} from "@legajo/shared";
import { Actor, HexHash, HistoryStamp, S3Key, ZonedInstant, defineEntity } from "./common";
import { EscalationId } from "./operations";

/** What made a document VALID: a reading without blocking observations, or a broker's waiver. */
export const ValidatedBy = z.enum(["READER", "WAIVER"]);
export type ValidatedBy = z.infer<typeof ValidatedBy>;

export const Document = defineEntity({
  operationId: OperationId,
  clockId: ClockId,
  docType: DocType,
  status: DocStatus,
  responsibleParty: Party.optional(),
  /** 0 until the first version arrives. */
  currentVersion: z.number().int().nonnegative().default(0),
  currentDocVersionId: DocVersionId.optional(),
  receivedAtSim: ZonedInstant.optional(),
  requestedFrom: Party.optional(),
  lastRequestedAtSim: ZonedInstant.optional(),
  validatedBy: ValidatedBy.optional(),
});
export type Document = z.output<typeof Document>;

/**
 * The reading as stored on the version: exactly the contract's `Reading` (packages/reader-contract,
 * ADR-0003), the reader's answer and never something we extracted.
 */
export const ReadingSnapshot = Reading;
export type ReadingSnapshot = z.output<typeof ReadingSnapshot>;

/** Lifecycle of a version: received, read by the reader, unknown to it, classified or discarded by the firm. */
export const VersionState = z.enum(["RECEIVED", "READ", "UNRECOGNIZED", "CLASSIFIED", "DISCARDED", "READER_UNAVAILABLE"]);
export type VersionState = z.infer<typeof VersionState>;

export const VersionSource = z.object({
  party: Party,
  channel: DocumentSourceChannel,
  messageId: MessageId.optional(),
  uploadToken: z.string().min(1).max(64).optional(),
  contactId: ContactId.optional(),
});
export type VersionSource = z.infer<typeof VersionSource>;

/** 10 MB: the size limit of every path a PDF comes in by (docs/architecture.md §6). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const DocumentVersion = defineEntity({
  docVersionId: DocVersionId,
  operationId: OperationId,
  clockId: ClockId,
  docType: DocType,
  versionNo: z.number().int().min(1),
  /** `Documents` key built by code (never from a file name). */
  s3Key: S3Key,
  sha256: HexHash,
  sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
  source: VersionSource,
  receivedAtSim: ZonedInstant,
  receivedAtReal: ZonedInstant.optional(),
  state: VersionState,
  reading: ReadingSnapshot.optional(),
  readAtSim: ZonedInstant.optional(),
  readerAttempts: z.number().int().nonnegative().default(0),
  classifiedAs: DocType.optional(),
  classifiedBy: Actor.optional(),
  discardedBy: Actor.optional(),
});
export type DocumentVersion = z.output<typeof DocumentVersion>;

export const ObservationEvent = HistoryStamp.extend({
  status: ObservationStatus,
  docVersionId: DocVersionId.optional(),
});
export type ObservationEvent = z.infer<typeof ObservationEvent>;

/** One observation per operation, document and code (`obs-4471-PL-GROSS_WEIGHT_MISMATCH`); attempts count on it. */
export const Observation = defineEntity({
  observationId: ObservationId,
  operationId: OperationId,
  clockId: ClockId,
  docType: DocType,
  code: ObservationCode,
  severity: ObservationSeverity,
  field: z.string().optional(),
  expected: z.string().optional(),
  found: z.string().optional(),
  againstDocType: DocType.optional(),
  status: ObservationStatus,
  responsibleParty: Party.optional(),
  matrixDefault: MatrixResponsible.optional(),
  matchesMatrix: z.boolean().optional(),
  /** A BROKER assignment, or one that differs from the matrix, is flagged for the firm to review. */
  flaggedForReview: z.boolean().default(false),
  rationale: z.string().max(300).optional(),
  attempts: z.number().int().nonnegative().default(0),
  firstDocVersionId: DocVersionId,
  lastDocVersionId: DocVersionId,
  escalationId: EscalationId.optional(),
  waiveReason: z.string().max(500).optional(),
  history: z.array(ObservationEvent).min(1),
});
export type Observation = z.output<typeof Observation>;

/** Statuses that still block the document (the rest are resolved, waived or out of the agent's hands). */
export const OPEN_OBSERVATION_STATUSES: readonly ObservationStatus[] = ["OPEN", "CORRECTION_REQUESTED", "ESCALATED"];

export function isBlocking(observation: Pick<Observation, "severity" | "status">): boolean {
  return observation.severity === "BLOCKING" && OPEN_OBSERVATION_STATUSES.includes(observation.status);
}

const DOC_VERSION_ID = /^dv-(\d{4})(?:-([a-z0-9]+))?-(CI|PL|CO)-([1-9]\d*)$/;

/** `dv-4471-PL-2` (or `dv-4471-j03-PL-2` in a cloned world) → the operation, document and version it names. */
export function parseDocVersionId(value: string): { operationId: string; docType: DocType; versionNo: number } | undefined {
  const match = DOC_VERSION_ID.exec(value);
  const docType = match ? docTypeFromShort(match[3] ?? "") : undefined;
  if (!match || docType === undefined) return undefined;
  return { operationId: operationIdOf(match[1] ?? "", match[2]), docType, versionNo: Number(match[4]) };
}
