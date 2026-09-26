// Mock of the external document reader (ADR-0003). Explicit re-exports only; the Lambda entry is
// "./handler" and the test kit "./testing" ("@legajo/reader-mock/<module>" resolves each module).
export { READER_MOCK_SCHEMAS, createReaderApp } from "./app";
export type { ReaderAppDeps, ReaderEvent, ReaderHttpRequest, ReaderHttpResponse } from "./app";

export {
  FaultClockId,
  FaultConfig,
  FaultItem,
  FaultMode,
  GroundTruthItem,
  GroundTruthReading,
  IdempotencyItem,
  catalogKeys,
  faultItem,
  groundTruthItems,
  idempotencyItem,
  isLive,
} from "./catalog";
export type { CatalogStore, FaultConfigInput, GroundTruthKey, Stamp } from "./catalog";

export { createDynamoCatalog, documentSend } from "./dynamo-catalog";
export type { DocumentSend } from "./dynamo-catalog";
export { createMemoryCatalog } from "./memory-catalog";
export type { MemoryCatalog } from "./memory-catalog";

export { FAULT_DELAYS_MS, FAULT_RETRY_AFTER_SECONDS, faultFor } from "./faults";
export type { FaultEffect } from "./faults";
export { DOC_ID_INFO_KEY, PDF_PARSER_LIMITS, countIndirectObjects, embeddedDocId } from "./pdf-meta";
export { EMBEDDED_ID_CONFIDENCE_PENALTY, READER_MOCK_VERSION, composeReading, parseReadingId, readingIdOf } from "./reading";
export type { Match } from "./reading";
export { SOURCE_TIMEOUT_MS, documentsSourceUrl, downloadSource } from "./source";
export type { DownloadFailure, DownloadResult, SourceFetch } from "./source";
