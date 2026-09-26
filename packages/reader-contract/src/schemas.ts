// Zod mirror of ../openapi.yaml, the contract of the external document reader (ADR-0003,
// docs/architecture-integrations.md §5). The client (packages/bff/src/reader/client.ts) and the mock
// (packages/reader-mock) validate with these schemas and nothing else; `npm run reader:contract`
// (scripts/reader/contract-check.ts) fails when any of them drifts from the YAML. The enums are the
// domain's own (`@legajo/shared`), so the check also keeps the domain and the contract in step.
//
// Objects strip unknown keys instead of rejecting them: a reader that adds a field in a minor
// version must not break the intake. Nothing here is `.strict()`, and the YAML says the same.
import { z } from "zod";
import { DocType, ObservationCode, ObservationSeverity, ReadingMatchedBy, ReadingStatus } from "@legajo/shared";

/** Lower-case hex SHA-256 of the file the reader downloads. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a lower-case hex SHA-256");
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const ReadingHints = z.object({
  expectedDocType: DocType.optional(),
  relatedReadingIds: z.array(z.string()).optional(),
  locale: z.string().optional(),
});
export type ReadingHints = z.infer<typeof ReadingHints>;

export const CreateReadingRequest = z.object({
  /** Pre-signed HTTPS GET of the file, valid 5 minutes. */
  source: z.object({ url: z.url() }),
  sha256: Sha256Hex,
  hints: ReadingHints.optional(),
});
export type CreateReadingRequest = z.infer<typeof CreateReadingRequest>;

export const ReadingFields = z.object({
  documentNumber: z.string().optional(),
  /** Invoice referenced (packing list, certificate) or own number (invoice). */
  invoiceNumber: z.string().optional(),
  issueDate: z.iso.date().optional(),
  issuerName: z.string().optional(),
  buyerName: z.string().optional(),
  buyerTaxId: z.string().optional(),
  incoterm: z.string().optional(),
  currency: z.string().optional(),
  totalAmount: z.number().optional(),
  grossWeightKg: z.number().optional(),
  netWeightKg: z.number().optional(),
  packages: z.int().optional(),
  originCountry: z.string().optional(),
  signed: z.boolean().optional(),
  stamped: z.boolean().optional(),
  issuingBody: z.string().optional(),
});
export type ReadingFields = z.infer<typeof ReadingFields>;

export const ReadingObservation = z.object({
  code: ObservationCode,
  severity: ObservationSeverity,
  field: z.string().optional(),
  expected: z.string().optional(),
  found: z.string().optional(),
  againstDocType: z.string().optional(),
});
export type ReadingObservation = z.infer<typeof ReadingObservation>;

/** What the reader answers for one file: `UNRECOGNIZED` goes to the broker, never to our own guess. */
export const Reading = z.object({
  readingId: z.string(),
  status: ReadingStatus,
  docType: DocType.optional(),
  matchedBy: ReadingMatchedBy.optional(),
  confidence: z.number().min(0).max(1).optional(),
  pages: z.int().optional(),
  language: z.string().optional(),
  fields: ReadingFields.optional(),
  observations: z.array(ReadingObservation).optional(),
  readerVersion: z.string(),
});
export type Reading = z.infer<typeof Reading>;

export const Health = z.object({ status: z.literal("ok"), readerVersion: z.string() });
export type Health = z.infer<typeof Health>;

export const ReaderErrorCode = z.enum(["INVALID_REQUEST", "FILE_TOO_LARGE", "NOT_FOUND", "RATE_LIMITED", "UNAVAILABLE"]);
export type ReaderErrorCode = z.infer<typeof ReaderErrorCode>;

/** Body of every non-200 answer. */
export const ReaderErrorBody = z.object({ code: ReaderErrorCode, message: z.string() });
export type ReaderErrorBody = z.infer<typeof ReaderErrorBody>;

/** `Idempotency-Key`: one per document version (the client sends the `docVersionId`). */
export const IdempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "expected letters, digits, '.', '_', ':' or '-'");
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

/** `X-Fault-Scope`: the clock of a QA world; test-only, a real reader ignores it. */
export const FaultScope = z.string().min(1).max(128);

export const ReadingIdParam = z.string().min(1).max(256);

/** `Retry-After` of a 429 or a 503, in seconds. */
export const RetryAfterSeconds = z.int().min(0);

/** Component schemas of the YAML, by their component name. */
export const READER_SCHEMAS = {
  CreateReadingRequest,
  ReadingHints,
  Reading,
  ReadingFields,
  ReadingObservation,
  Health,
  Error: ReaderErrorBody,
} as const;
export type ReaderSchemaName = keyof typeof READER_SCHEMAS;

export type ParameterLocation = "header" | "path";

export interface ReaderParameterSpec {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly required: boolean;
  readonly schema: z.ZodType;
}

/** Parameter components of the YAML, by their component name. */
export const READER_PARAMETERS = {
  IdempotencyKey: { name: "Idempotency-Key", in: "header", required: true, schema: IdempotencyKey },
  FaultScope: { name: "X-Fault-Scope", in: "header", required: false, schema: FaultScope },
  ReadingId: { name: "readingId", in: "path", required: true, schema: ReadingIdParam },
} as const satisfies Record<string, ReaderParameterSpec>;
export type ReaderParameterName = keyof typeof READER_PARAMETERS;

/** Response header components of the YAML, by their component name. */
export const READER_RESPONSE_HEADERS = {
  RetryAfter: { name: "Retry-After", schema: RetryAfterSeconds },
} as const;
export type ReaderResponseHeaderName = keyof typeof READER_RESPONSE_HEADERS;
