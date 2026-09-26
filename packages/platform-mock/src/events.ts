// Events the platform mock publishes to the stage's `Feeds` bus (docs/architecture-integrations.md §6):
// the carrier's `CarrierEtaChanged` and customs' `CustomsStatusChanged`. `FeedEvents` (WP-29) validates
// what the bus rule hands it with `FeedEventEnvelope` and deduplicates by `detail.eventId`, so every
// event carries a unique `evt_<ULID>`; a replay of the same request re-publishes the same id.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CustomsChannel, DispatchStatus, FirmId, OperationNumber } from "@legajo/shared";
import { ZonedInstant } from "./schema";

export const PLATFORM_EVENT_SOURCE = {
  carrier: "mock.platform.carrier",
  customs: "mock.platform.customs",
} as const;

export const PlatformEventSource = z.enum([PLATFORM_EVENT_SOURCE.carrier, PLATFORM_EVENT_SOURCE.customs]);
export type PlatformEventSource = z.infer<typeof PlatformEventSource>;

export const PlatformDetailType = z.enum(["CarrierEtaChanged", "CustomsStatusChanged"]);
export type PlatformDetailType = z.infer<typeof PlatformDetailType>;

// ---- Event ids -----------------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `evt_` + a ULID: 48-bit millisecond time and 80 random bits in Crockford base32. */
export const PlatformEventId = z.string().regex(/^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "expected evt_<ULID>");
export type PlatformEventId = z.infer<typeof PlatformEventId>;

/**
 * A new event id for real time `nowMs`. Each random byte maps to one base32 character (256 is a
 * multiple of 32, so the characters stay uniform); ids of the same millisecond differ in their 80
 * random bits and ids of later milliseconds sort after.
 */
export function newPlatformEventId(nowMs: number, random: (size: number) => Uint8Array = randomBytes): PlatformEventId {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48) throw new RangeError(`event id time out of range: ${nowMs}`);
  const entropy = random(16);
  if (entropy.length !== 16) throw new RangeError("an event id needs 16 random bytes");
  let time = "";
  for (let rest = nowMs, index = 0; index < 10; index += 1, rest = Math.floor(rest / 32)) time = CROCKFORD.charAt(rest % 32) + time;
  return `evt_${time}${Array.from(entropy, (byte) => CROCKFORD.charAt(byte % 32)).join("")}`;
}

// ---- Details -------------------------------------------------------------------------------------

/** Why the carrier moved the ETA: the mock derives it from the previous and the new ETA. */
export const EtaChangeReason = z.enum(["SCHEDULE_ADVANCED", "SCHEDULE_DELAYED"]);
export type EtaChangeReason = z.infer<typeof EtaChangeReason>;

/** Statuses customs publishes; `NONE` is only the state before the first event. */
export const PublishedDispatchStatus = DispatchStatus.exclude(["NONE"]);
export type PublishedDispatchStatus = z.infer<typeof PublishedDispatchStatus>;

/** `channel` comes with `CANAL_ASIGNADO` and only with it (CONTEXT.md, "Estado del despacho"). */
export function checkCustomsChannel(value: { status: PublishedDispatchStatus; channel?: CustomsChannel | undefined }, ctx: z.RefinementCtx): void {
  if (value.status === "CANAL_ASIGNADO" && value.channel === undefined) {
    ctx.addIssue({ code: "custom", message: "CANAL_ASIGNADO needs a channel", path: ["channel"] });
  }
  if (value.status !== "CANAL_ASIGNADO" && value.channel !== undefined) {
    ctx.addIssue({ code: "custom", message: "only CANAL_ASIGNADO carries a channel", path: ["channel"] });
  }
}

export const CarrierEtaChangedDetail = z
  .object({
    eventId: PlatformEventId,
    firmId: FirmId,
    operationNumber: OperationNumber,
    vessel: z.string().min(1).max(200),
    previousEta: ZonedInstant,
    newEta: ZonedInstant,
    reason: EtaChangeReason,
    occurredAtSim: ZonedInstant,
  })
  .strict();
export type CarrierEtaChangedDetail = z.infer<typeof CarrierEtaChangedDetail>;

export const CustomsStatusChangedDetail = z
  .object({
    eventId: PlatformEventId,
    firmId: FirmId,
    operationNumber: OperationNumber,
    status: PublishedDispatchStatus,
    channel: CustomsChannel.optional(),
    occurredAtSim: ZonedInstant,
  })
  .strict()
  .superRefine(checkCustomsChannel);
export type CustomsStatusChangedDetail = z.infer<typeof CustomsStatusChangedDetail>;

// ---- Events as the mock publishes them -----------------------------------------------------------

export const CarrierEtaChanged = z
  .object({
    source: z.literal(PLATFORM_EVENT_SOURCE.carrier),
    detailType: z.literal("CarrierEtaChanged"),
    detail: CarrierEtaChangedDetail,
  })
  .strict();
export type CarrierEtaChanged = z.infer<typeof CarrierEtaChanged>;

export const CustomsStatusChanged = z
  .object({
    source: z.literal(PLATFORM_EVENT_SOURCE.customs),
    detailType: z.literal("CustomsStatusChanged"),
    detail: CustomsStatusChangedDetail,
  })
  .strict();
export type CustomsStatusChanged = z.infer<typeof CustomsStatusChanged>;

export const PlatformFeedEvent = z.discriminatedUnion("detailType", [CarrierEtaChanged, CustomsStatusChanged]);
export type PlatformFeedEvent = z.infer<typeof PlatformFeedEvent>;

export function carrierEtaChanged(detail: CarrierEtaChangedDetail): CarrierEtaChanged {
  return CarrierEtaChanged.parse({ source: PLATFORM_EVENT_SOURCE.carrier, detailType: "CarrierEtaChanged", detail });
}

export function customsStatusChanged(detail: CustomsStatusChangedDetail): CustomsStatusChanged {
  return CustomsStatusChanged.parse({ source: PLATFORM_EVENT_SOURCE.customs, detailType: "CustomsStatusChanged", detail });
}

/** One entry of `PutEvents` (`Detail` is a JSON string, as EventBridge requires). */
export interface PutEventsEntry {
  readonly EventBusName: string;
  readonly Source: PlatformEventSource;
  readonly DetailType: PlatformDetailType;
  readonly Detail: string;
}

export function toPutEventsEntry(event: PlatformFeedEvent, busName: string): PutEventsEntry {
  const parsed = PlatformFeedEvent.parse(event);
  return { EventBusName: busName, Source: parsed.source, DetailType: parsed.detailType, Detail: JSON.stringify(parsed.detail) };
}

// ---- Envelope a bus rule delivers ----------------------------------------------------------------

// EventBridge adds its own keys (`version`, `account`, `region`, `resources`); they are accepted and
// dropped, while the detail stays strict.
const EnvelopeBase = {
  id: z.string().min(1),
  time: z.string().optional(),
};

/** What a target of the `Feeds` rule receives (`FeedEvents`, WP-29): source, detail type and detail agree. */
export const FeedEventEnvelope = z.discriminatedUnion("detail-type", [
  z.object({
    ...EnvelopeBase,
    source: z.literal(PLATFORM_EVENT_SOURCE.carrier),
    "detail-type": z.literal("CarrierEtaChanged"),
    detail: CarrierEtaChangedDetail,
  }),
  z.object({
    ...EnvelopeBase,
    source: z.literal(PLATFORM_EVENT_SOURCE.customs),
    "detail-type": z.literal("CustomsStatusChanged"),
    detail: CustomsStatusChangedDetail,
  }),
]);
export type FeedEventEnvelope = z.infer<typeof FeedEventEnvelope>;
