// Mock of the customs management platform (docs/architecture-integrations.md §6): operation master
// data, ETA changes and customs status events on the `Feeds` bus. Explicit re-exports only; the
// Lambda entry is `./handler` (infra/mocks.ts) and is not re-exported, so importing the schemas never
// pulls `sst` or the AWS clients into a caller.

export {
  CustomsState,
  Incoterm,
  PLATFORM_EVENT_SK_PREFIX,
  PLATFORM_META_SK,
  PlatformDocuments,
  PlatformItemMeta,
  PlatformOperation,
  PlatformOperationItem,
  ZonedInstant,
  instantMs,
  platformEventSk,
  platformPk,
  toPlatformOperation,
  toPlatformOperationItem,
  worldAttributesOf,
} from "./schema";
export type { PlatformItemOptions, PlatformOperationInput, PlatformWorldAttributes } from "./schema";

export {
  CarrierEtaChanged,
  CarrierEtaChangedDetail,
  CustomsStatusChanged,
  CustomsStatusChangedDetail,
  EtaChangeReason,
  FeedEventEnvelope,
  PLATFORM_EVENT_SOURCE,
  PlatformDetailType,
  PlatformEventId,
  PlatformEventSource,
  PlatformFeedEvent,
  PublishedDispatchStatus,
  carrierEtaChanged,
  customsStatusChanged,
  newPlatformEventId,
  toPutEventsEntry,
} from "./events";
export type { PutEventsEntry } from "./events";

export {
  CORRELATION_HEADER,
  CustomsStatusRequest,
  EtaChangeRequest,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  MAX_BODY_BYTES,
  PlatformConflictReason,
  PlatformErrorBody,
  PlatformErrorCode,
  PlatformEventResponse,
  PlatformHealth,
  platformPaths,
} from "./api";

export { PLATFORM_TABLE, PlatformEventItem, applyPatch, createMemoryPlatformStore, toPlatformEventItem } from "./store";
export type { MemoryPlatformStore, PlatformChange, PlatformOperationPatch, PlatformStore } from "./store";

export { createDynamoPlatformStore } from "./dynamo-store";
export { createEventBridgePublisher, createRecordingPublisher } from "./publisher";
export type { PlatformEventPublisher, RecordingPublisher } from "./publisher";

export { PLATFORM_ROUTES, createPlatformApp } from "./app";
export type { PlatformApp, PlatformAppDeps, PlatformRoute } from "./app";
export type { PlatformRequest, PlatformResponse } from "./http";
export { createFunctionUrlHandler } from "./lambda";
export type { FunctionUrlHandler, FunctionUrlResult } from "./lambda";
