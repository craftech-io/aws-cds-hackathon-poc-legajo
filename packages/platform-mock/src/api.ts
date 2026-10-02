// HTTP contract of the platform mock (docs/architecture-integrations.md §6), shared by the mock and
// its callers (the console's BFF, the `QaDriver` and the in-process transport of the local flows).
//
//   GET  /v1/operations/{operationNumber}?firm=<firmId>                  → PlatformOperation
//   POST /v1/operations/{operationNumber}/eta?firm=<firmId>              → PlatformEventResponse (CarrierEtaChanged)
//   POST /v1/operations/{operationNumber}/customs-status?firm=<firmId>   → PlatformEventResponse (CustomsStatusChanged)
//   GET  /v1/health                                                      → { status: "ok" }
//
// Every operation route is scoped by `firm`, like the table key `POP#<firmId>#<n>`: operation numbers
// repeat across guest firms. The two POST routes need an `Idempotency-Key`: a retry with the same key
// and body re-publishes the same event (same `eventId`) instead of changing the operation twice.
import { z } from "zod";
import { CustomsChannel, FirmId, OperationNumber } from "@legajo/shared";
import { PlatformFeedEvent, PublishedDispatchStatus, checkCustomsChannel } from "./events";
import { ZonedInstant } from "./schema";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const CORRELATION_HEADER = "x-correlation-id";

/** Largest request body the mock reads; its bodies are a few hundred bytes. */
export const MAX_BODY_BYTES = 8 * 1024;

/** 1 to 128 characters; the `QaDriver` uses `runId/escenario/paso`. */
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/, "expected an Idempotency-Key of 1-128 safe characters");
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

/** `POST …/eta`: the carrier moved the ETA; `occurredAtSim` is the simulated time of the caller's world. */
export const EtaChangeRequest = z
  .object({
    newEta: ZonedInstant,
    occurredAtSim: ZonedInstant,
  })
  .strict();
export type EtaChangeRequest = z.infer<typeof EtaChangeRequest>;

/** `POST …/customs-status`: customs moved the dispatch forward (`channel` only with `CANAL_ASIGNADO`). */
export const CustomsStatusRequest = z
  .object({
    status: PublishedDispatchStatus,
    channel: CustomsChannel.optional(),
    occurredAtSim: ZonedInstant,
  })
  .strict()
  .superRefine(checkCustomsChannel);
export type CustomsStatusRequest = z.infer<typeof CustomsStatusRequest>;

/** Answer of both POST routes: the event as published; `replayed` when an earlier request with the same key made it. */
export const PlatformEventResponse = z
  .object({
    event: PlatformFeedEvent,
    replayed: z.boolean(),
  })
  .strict();
export type PlatformEventResponse = z.infer<typeof PlatformEventResponse>;

export const PlatformHealth = z.object({ status: z.literal("ok") }).strict();
export type PlatformHealth = z.infer<typeof PlatformHealth>;

export const PlatformErrorCode = z.enum(["INVALID_REQUEST", "NOT_FOUND", "METHOD_NOT_ALLOWED", "PAYLOAD_TOO_LARGE", "CONFLICT", "UNAVAILABLE", "INTERNAL"]);
export type PlatformErrorCode = z.infer<typeof PlatformErrorCode>;

/** Why a change was refused with `CONFLICT`. */
export const PlatformConflictReason = z.enum(["ETA_UNCHANGED", "STATUS_NOT_FORWARD", "VERSION_CONFLICT", "IDEMPOTENCY_KEY_REUSED"]);
export type PlatformConflictReason = z.infer<typeof PlatformConflictReason>;

export const PlatformErrorBody = z
  .object({
    error: z
      .object({
        code: PlatformErrorCode,
        message: z.string(),
        reason: PlatformConflictReason.optional(),
      })
      .strict(),
  })
  .strict();
export type PlatformErrorBody = z.infer<typeof PlatformErrorBody>;

function operationBase(operationNumber: string): string {
  return `/v1/operations/${OperationNumber.parse(operationNumber)}`;
}

function firmQuery(firmId: string): string {
  return `?firm=${encodeURIComponent(FirmId.parse(firmId))}`;
}

/** Path and query of every route, for the callers. */
export const platformPaths = {
  health: (): string => "/v1/health",
  operation: (firmId: string, operationNumber: string): string => `${operationBase(operationNumber)}${firmQuery(firmId)}`,
  eta: (firmId: string, operationNumber: string): string => `${operationBase(operationNumber)}/eta${firmQuery(firmId)}`,
  customsStatus: (firmId: string, operationNumber: string): string => `${operationBase(operationNumber)}/customs-status${firmQuery(firmId)}`,
} as const;
