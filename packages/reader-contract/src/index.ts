// Contract of the external document reader (ADR-0003): openapi.yaml and its zod mirror. Explicit
// re-exports only; "@legajo/reader-contract/<module>" also resolves.
export {
  CreateReadingRequest,
  FaultScope,
  Health,
  IdempotencyKey,
  READER_PARAMETERS,
  READER_RESPONSE_HEADERS,
  READER_SCHEMAS,
  Reading,
  ReadingFields,
  ReadingHints,
  ReadingIdParam,
  ReadingObservation,
  ReaderErrorBody,
  ReaderErrorCode,
  RetryAfterSeconds,
  Sha256Hex,
} from "./schemas";
export type { ParameterLocation, ReaderParameterName, ReaderParameterSpec, ReaderResponseHeaderName, ReaderSchemaName } from "./schemas";

export { READER_HEADERS, READER_LIMITS, READER_OPERATIONS, READER_SOURCE_REGION, readingPath } from "./operations";
export type { HttpMethod, ReaderOperationName, ReaderOperationSpec } from "./operations";
