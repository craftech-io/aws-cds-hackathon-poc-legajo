// Media of an inbound WhatsApp (FL-017, FL-018, FL-090). Only a PDF of at most 10 MB goes on: the
// transport puts it in `Media` (live `GetWhatsAppMessageMedia`, simulated `sim-media:` key) and an
// object of another type, over the limit or whose bytes do not start with `%PDF-` is deleted as soon as
// it is there. Images, audio, video, stickers and the rest are never downloaded; they get a fixed reply.
//
// A PDF reaches the intake only after GuardDuty scanned it (docs/architecture.md §6). The scan result
// goes to `DocumentIntake`, which does not know the operation of a `Media` key; this adapter does. The
// two meet on two `Runtime/IDEMP#` marks of the object key, whichever arrives second enqueues
// `INTAKE_DOCUMENT` (both would enqueue the same `eventId`, derived from the key):
//
//   InboundWhatsApp   (1) `ScanPending` if the scan is not clean yet  (2) `WA_MEDIA` route
//                     (3) scan already clean → enqueue and close the pending
//   DocumentIntake    (1) `MEDIA_SCAN_CLEAN` on NO_THREATS_FOUND      (2) route present → enqueue
//                     (3) close the pending either way (`markMediaScanClean` below)
import { z } from "zod";
import { ChannelError, ClockId, ConnectorError, FirmId, MessageId, OperationId } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import { HexHash } from "../../domain/common";
import { sha256Hex } from "../../lib/crypto";
import { type ChannelEventSink, IntakeDocumentEvent, derivedEventId } from "../adapter";
import { MAX_MEDIA_BYTES, PDF_MIME_TYPE } from "./config";
import type { WaInboundMessage, WaMediaObject } from "./payloads";
import type { MediaStore, WhatsAppTransport } from "./transport";

/** A PDF the adapter kept in `Media`: its key and what the intake event carries of it. */
export const AcceptedMedia = z.strictObject({ objectKey: z.string().min(1).max(1_024), sha256: HexHash, sizeBytes: z.number().int().positive().max(MAX_MEDIA_BYTES) });
export type AcceptedMedia = z.infer<typeof AcceptedMedia>;

export type MediaVerdict =
  | ({ readonly accepted: true } & AcceptedMedia)
  | { readonly accepted: false; readonly reason: "NOT_PDF" | "TOO_LARGE" | "REFUSED"; readonly contentType: string; readonly sizeBytes: number };

/** The media object of a message of any media type (`document`, `image`…), if it has one. */
export function mediaObjectOf(message: WaInboundMessage): WaMediaObject | undefined {
  return message.document ?? message.image ?? message.audio ?? message.video ?? message.sticker;
}

function isPdf(contentType: string): boolean {
  return contentType.split(";")[0]?.trim().toLowerCase() === PDF_MIME_TYPE;
}

/**
 * Brings a document into `Media` and keeps it only if it is a PDF within the limit. A document that
 * does not even say it is a PDF is never downloaded.
 */
export async function acceptDocument(
  transport: WhatsAppTransport,
  media: MediaStore,
  input: { readonly wamid: string; readonly document: WaMediaObject; readonly clockId: string; readonly qaRunId?: string },
): Promise<MediaVerdict> {
  const declared = input.document.mime_type ?? "";
  if (!isPdf(declared)) return { accepted: false, reason: "NOT_PDF", contentType: declared || "unknown", sizeBytes: 0 };
  let fetched: Awaited<ReturnType<WhatsAppTransport["fetchMedia"]>>;
  try {
    fetched = await transport.fetchMedia({ mediaId: input.document.id, wamid: input.wamid, clockId: input.clockId, ...(input.qaRunId === undefined ? {} : { qaRunId: input.qaRunId }) });
  } catch (error) {
    // A reference the transport refuses (another world's key, a simulated one in live mode) is never retried.
    if (error instanceof ChannelError && error.code === "INVALID") return { accepted: false, reason: "REFUSED", contentType: declared, sizeBytes: 0 };
    throw error;
  }
  const oversized = fetched.sizeBytes > MAX_MEDIA_BYTES || fetched.sizeBytes < 1;
  const digest = !isPdf(fetched.contentType) || oversized ? undefined : await media.digest(fetched.key);
  if (digest !== undefined && digest.isPdf && digest.sizeBytes <= MAX_MEDIA_BYTES) return { accepted: true, objectKey: fetched.key, sha256: digest.sha256, sizeBytes: digest.sizeBytes };
  await media.delete(fetched.key);
  const tooLarge = oversized || (digest?.sizeBytes ?? 0) > MAX_MEDIA_BYTES;
  return { accepted: false, reason: tooLarge ? "TOO_LARGE" : "NOT_PDF", contentType: fetched.contentType, sizeBytes: fetched.sizeBytes };
}

// ---- Rendezvous with DocumentIntake ----------------------------------------------------------------

/** `IDEMP#WA_MEDIA#<key>`: the operation and message a `Media` object of WhatsApp belongs to. */
export const MEDIA_ROUTE_SOURCE = "WA_MEDIA";
/** `IDEMP#MEDIA_SCAN_CLEAN#<key>`: GuardDuty found no threat in the object. */
export const MEDIA_SCAN_CLEAN_SOURCE = "MEDIA_SCAN_CLEAN";

export const MediaRoute = AcceptedMedia.extend({
  operationId: OperationId,
  clockId: ClockId,
  firmId: FirmId,
  messageId: MessageId,
  eventAtSim: z.string().min(1),
});
export type MediaRoute = z.infer<typeof MediaRoute>;

/** `SCAN#<sha8 of the key>` of the object's pending scan. */
export function scanKeyOf(objectKey: string): string {
  return sha256Hex(objectKey).slice(0, 8);
}

/** The `INTAKE_DOCUMENT` both sides enqueue for a routed, clean object (id derived from the key). */
export function mediaIntakeEvent(route: MediaRoute): IntakeDocumentEvent {
  return IntakeDocumentEvent.parse({
    type: "INTAKE_DOCUMENT",
    eventId: derivedEventId("INTAKE_DOCUMENT", route.objectKey),
    operationId: route.operationId,
    clockId: route.clockId,
    firmId: route.firmId,
    eventAtSim: route.eventAtSim,
    source: { party: "IMPORTER", channel: "WHATSAPP", messageId: route.messageId },
    object: { store: "MEDIA", key: route.objectKey },
    sha256: route.sha256,
    sizeBytes: route.sizeBytes,
  });
}

type Runtime = Pick<Connector, "runtime" | "world">;

async function isScanClean(data: Runtime, objectKey: string): Promise<boolean> {
  return (await data.runtime.getIdempotency(MEDIA_SCAN_CLEAN_SOURCE, objectKey)) !== undefined;
}

async function putScanPending(data: Runtime, route: MediaRoute, atReal: string): Promise<void> {
  try {
    await data.world.putScanPending({ clockId: route.clockId, scanKey: scanKeyOf(route.objectKey), bucket: "Media", objectKey: route.objectKey, operationId: route.operationId, createdAtReal: atReal });
  } catch (error) {
    // The phone simulator wrote it when it uploaded the PDF: one pending per object.
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
  }
}

/** This adapter's half: the world stays busy until the scan, then the intake is enqueued once. */
export async function routeMedia(data: Runtime, events: ChannelEventSink, route: MediaRoute, atReal: string): Promise<"ENQUEUED" | "AWAITING_SCAN"> {
  if (!(await isScanClean(data, route.objectKey))) await putScanPending(data, route, atReal);
  await data.runtime.claimIdempotency({ source: MEDIA_ROUTE_SOURCE, id: route.objectKey, atReal, result: { ...route } });
  if (!(await isScanClean(data, route.objectKey))) return "AWAITING_SCAN";
  await events.enqueue(mediaIntakeEvent(route));
  await data.world.closeScanPending(route.clockId, scanKeyOf(route.objectKey));
  return "ENQUEUED";
}

/** The route of a `Media` object, if the adapter recorded one. */
export async function mediaRouteOf(data: Pick<Connector, "runtime">, objectKey: string): Promise<MediaRoute | undefined> {
  const mark = await data.runtime.getIdempotency(MEDIA_ROUTE_SOURCE, objectKey);
  const route = MediaRoute.safeParse(mark?.result);
  return route.success && route.data.objectKey === objectKey ? route.data : undefined;
}

/**
 * `DocumentIntake`'s half, for a `NO_THREATS_FOUND` result on a `Media` object: records the clean scan,
 * enqueues the intake if the route is known, and closes the pending scan of the world.
 */
export async function markMediaScanClean(data: Runtime, events: ChannelEventSink, input: { readonly objectKey: string; readonly clockId?: string; readonly atReal: string }): Promise<"ENQUEUED" | "AWAITING_ROUTE"> {
  await data.runtime.claimIdempotency({ source: MEDIA_SCAN_CLEAN_SOURCE, id: input.objectKey, atReal: input.atReal });
  const route = await mediaRouteOf(data, input.objectKey);
  if (route !== undefined) await events.enqueue(mediaIntakeEvent(route));
  const clockId = route?.clockId ?? input.clockId;
  if (clockId !== undefined) await data.world.closeScanPending(clockId, scanKeyOf(input.objectKey));
  return route === undefined ? "AWAITING_ROUTE" : "ENQUEUED";
}
