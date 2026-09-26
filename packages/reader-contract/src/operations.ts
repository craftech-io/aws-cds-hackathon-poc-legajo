// Routes, headers and limits of the document reader contract (../openapi.yaml). The mock routes by
// this table and the client builds its requests from it; scripts/reader/contract-check.ts compares
// it with the `paths` of the YAML.
import type { ReaderParameterName, ReaderResponseHeaderName, ReaderSchemaName } from "./schemas";

export type HttpMethod = "get" | "post";

export interface ReaderOperationSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly parameters: readonly ReaderParameterName[];
  /** Component schema of the JSON body, when the operation takes one. */
  readonly requestBody?: ReaderSchemaName;
  /** Component schema of the JSON body of each status code. */
  readonly responses: Readonly<Record<string, ReaderSchemaName>>;
  /** Response headers per status code. */
  readonly responseHeaders?: Readonly<Record<string, readonly ReaderResponseHeaderName[]>>;
}

export const READER_OPERATIONS = {
  createReading: {
    method: "post",
    path: "/v1/readings",
    parameters: ["IdempotencyKey", "FaultScope"],
    requestBody: "CreateReadingRequest",
    responses: { "200": "Reading", "400": "Error", "413": "Error", "429": "Error", "503": "Error" },
    responseHeaders: { "429": ["RetryAfter"], "503": ["RetryAfter"] },
  },
  getReading: {
    method: "get",
    path: "/v1/readings/{readingId}",
    parameters: ["ReadingId"],
    responses: { "200": "Reading", "404": "Error" },
  },
  health: {
    method: "get",
    path: "/v1/health",
    parameters: [],
    responses: { "200": "Health" },
  },
} as const satisfies Record<string, ReaderOperationSpec>;
export type ReaderOperationName = keyof typeof READER_OPERATIONS;

/** Wire names of the headers of the contract (HTTP headers are case-insensitive; Lambda lower-cases them). */
export const READER_HEADERS = {
  idempotencyKey: "Idempotency-Key",
  faultScope: "X-Fault-Scope",
  retryAfter: "Retry-After",
} as const;

export const READER_LIMITS = {
  /** A larger file is answered with 413 without reading it. */
  maxFileBytes: 10 * 1024 * 1024,
  /** Validity of the pre-signed GET the caller sends as `source.url`. */
  sourceUrlTtlSeconds: 300,
  /** Same `Idempotency-Key` and SHA-256 → same reading for this long. */
  idempotencyTtlHours: 48,
} as const;

/**
 * Region of the stage's `Documents` bucket. Pre-signed source URLs are regional virtual-hosted S3
 * URLs of it (`https://<bucket>.s3.us-east-1.amazonaws.com/<key>`), the only form the mock accepts.
 */
export const READER_SOURCE_REGION = "us-east-1";

/** `/v1/readings/<readingId>`, with the id escaped as one path segment. */
export function readingPath(readingId: string): string {
  return READER_OPERATIONS.getReading.path.replace("{readingId}", encodeURIComponent(readingId));
}
