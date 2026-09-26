import { GetWhatsAppMessageMediaCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { importerEsAR } from "../../copy/es-AR";
import { sha256Hex } from "../../lib/crypto";
import { derivedEventId } from "../adapter";
import { processWhatsAppEvent } from "./inbound";
import { liveWhatsAppTransport } from "./live-transport";
import { MEDIA_ROUTE_SOURCE, MEDIA_SCAN_CLEAN_SOURCE, markMediaScanClean, mediaRouteOf, scanKeyOf } from "./media";
import { CLOCK, PHONE, REAL_NOW, type WaWorld, liveEvent, simEvent, waWorld } from "./testing";

const SIM_KEY = "sim/msg-01JAB3C4D5E6F7G8H9J0KMNPQR/1.pdf";
const MEDIA_ID = "1234567890123456";
const LIVE_WAMID = "wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABIYFDNBQjI4RjdEMkUzOTVDNjE2RDQ2AA==";
const LIVE_KEY = `wa/${LIVE_WAMID}/${MEDIA_ID}`;

function simDocument(key = SIM_KEY) {
  return simEvent({ type: "document", mediaRef: `sim-media:${key}`, filename: "packing-list.pdf" });
}

async function pendingScans(world: WaWorld) {
  return (await world.stores.connector.world.listPending(CLOCK)).scans;
}

async function firstInbound(world: WaWorld) {
  return (await world.stores.connector.conversations.listMessages("op-4471", { direction: "IN" }))[0];
}

/** The live transport over a mocked End User Messaging Social that writes what the test says into Media. */
function goLive(world: WaWorld, media: { readonly mimeType: string; readonly fileSize: number; readonly bytes?: string }) {
  const sdk = mockClient(SocialMessagingClient);
  sdk.on(GetWhatsAppMessageMediaCommand).callsFake(async (input: { destinationS3File?: { key?: string }; mediaId?: string }) => {
    world.media.objects.set(`${input.destinationS3File?.key ?? ""}${input.mediaId ?? ""}`, { sizeBytes: media.fileSize, contentType: media.mimeType, ...(media.bytes === undefined ? {} : { bytes: media.bytes }) });
    return { mimeType: media.mimeType, fileSize: media.fileSize };
  });
  const transport = liveWhatsAppTransport({
    phoneNumberId: "phone-number-id-0123456789abcdef0123456789abcdef",
    mediaBucket: "aws-cds-hackathon-poc-leg-poc-media-776805327629",
    allowedPhones: [PHONE],
    templates: world.stores.connector.reference,
    media: world.media,
    realClock: world.deps.realClock,
    client: new SocialMessagingClient({ region: "us-east-1" }),
    retry: { sleep: async () => undefined },
  });
  return { sdk, deps: { ...world.deps, mode: "live" as const, transport } };
}

describe("[FL-017] a PDF by WhatsApp", () => {
  it("[FL-017] from the phone simulator: accepted into the timeline, waiting for the malware scan before the intake", async () => {
    const world = await waWorld();
    world.media.objects.set(SIM_KEY, { sizeBytes: 480_000, contentType: "application/pdf" });
    const summary = await processWhatsAppEvent(simDocument(), world.deps);
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "DOCUMENT", operationId: "op-4471" });
    const message = await firstInbound(world);
    expect(message?.attachments).toEqual([{ index: 0, filename: "packing-list.pdf", contentType: "application/pdf", sizeBytes: 480_000, status: "ACCEPTED", s3Key: SIM_KEY }]);
    expect(world.events).toEqual([]);
    expect(await pendingScans(world)).toMatchObject([{ bucket: "Media", objectKey: SIM_KEY, scanKey: scanKeyOf(SIM_KEY), operationId: "op-4471" }]);
    expect(await mediaRouteOf(world.stores.connector, SIM_KEY)).toMatchObject({ operationId: "op-4471", messageId: message?.messageId, sha256: sha256Hex(`%PDF-1.4 ${SIM_KEY}`), sizeBytes: 480_000 });

    // DocumentIntake's half: a clean scan sends the PDF to the intake of its operation and frees the world.
    expect(await markMediaScanClean(world.stores.connector, world.deps.events, { objectKey: SIM_KEY, atReal: REAL_NOW })).toBe("ENQUEUED");
    expect(world.events).toEqual([
      {
        type: "INTAKE_DOCUMENT",
        eventId: derivedEventId("INTAKE_DOCUMENT", SIM_KEY),
        operationId: "op-4471",
        clockId: CLOCK,
        firmId: "firm-delta",
        eventAtSim: "2026-10-14T13:30:00.000Z",
        source: { channel: "WHATSAPP", party: "IMPORTER", messageId: message?.messageId },
        object: { store: "MEDIA", key: SIM_KEY },
        sha256: sha256Hex(`%PDF-1.4 ${SIM_KEY}`),
        sizeBytes: 480_000,
      },
    ]);
    expect(await pendingScans(world)).toEqual([]);
  });

  it("[FL-017] a scan that finished first: the adapter enqueues the intake itself and leaves nothing pending", async () => {
    const world = await waWorld();
    world.media.objects.set(SIM_KEY, { sizeBytes: 480_000, contentType: "application/pdf" });
    expect(await markMediaScanClean(world.stores.connector, world.deps.events, { objectKey: SIM_KEY, clockId: CLOCK, atReal: REAL_NOW })).toBe("AWAITING_ROUTE");
    await processWhatsAppEvent(simDocument(), world.deps);
    expect(world.events.map((event) => [event.type, event.eventId])).toEqual([["INTAKE_DOCUMENT", derivedEventId("INTAKE_DOCUMENT", SIM_KEY)]]);
    expect(await pendingScans(world)).toEqual([]);
    expect(await world.stores.connector.runtime.getIdempotency(MEDIA_SCAN_CLEAN_SOURCE, SIM_KEY)).toBeDefined();
    expect(await world.stores.connector.runtime.getIdempotency(MEDIA_ROUTE_SOURCE, SIM_KEY)).toBeDefined();
  });

  it("[FL-017] a simulated key of another world is refused as media, never read", async () => {
    const world = await waWorld();
    const foreign = "qa/812-1/sim/msg-01JAB3C4D5E6F7G8H9J0KMNPQR/1.pdf";
    world.media.objects.set(foreign, { sizeBytes: 480_000, contentType: "application/pdf" });
    const summary = await processWhatsAppEvent(simDocument(foreign), world.deps);
    expect(summary.records[0]?.messages[0]?.outcome).toBe("MEDIA_REJECTED");
    expect((await firstInbound(world))?.attachments).toMatchObject([{ status: "REJECTED", reason: "REFUSED" }]);
    expect(world.replies.map((reply) => reply.textKey)).toEqual(["rejectedMedia"]);
    expect(await pendingScans(world)).toEqual([]);
  });
});

describe("[FL-090] media of live WhatsApp", () => {
  it("[FL-090] GetWhatsAppMessageMedia writes the PDF under wa/<wamid>/ with the connected number", async () => {
    const world = await waWorld();
    const live = goLive(world, { mimeType: "application/pdf", fileSize: 912_000 });
    const summary = await processWhatsAppEvent(liveEvent("sns-document.json", { MIME: "application/pdf", MEDIA_ID }), live.deps);
    expect(summary.records[0]).toMatchObject({ accepted: true, simulated: false, messages: [{ outcome: "DOCUMENT" }] });
    expect(live.sdk.commandCalls(GetWhatsAppMessageMediaCommand)[0]?.args[0].input).toEqual({
      mediaId: MEDIA_ID,
      originationPhoneNumberId: "phone-number-id-0123456789abcdef0123456789abcdef",
      destinationS3File: { bucketName: "aws-cds-hackathon-poc-leg-poc-media-776805327629", key: `wa/${LIVE_WAMID}/` },
    });
    expect((await firstInbound(world))?.attachments).toMatchObject([{ status: "ACCEPTED", s3Key: LIVE_KEY, sizeBytes: 912_000 }]);
    expect(await pendingScans(world)).toMatchObject([{ objectKey: LIVE_KEY }]);
    live.sdk.restore();
  });

  it("[FL-090] a PDF over 10 MB, or a file that is not a PDF by its type or its bytes, is deleted as soon as it is downloaded", async () => {
    const cases = [
      [{ mimeType: "application/pdf", fileSize: 10 * 1024 * 1024 + 1 }, "mediaTooLarge"],
      [{ mimeType: "image/png", fileSize: 20_000 }, "rejectedMedia"],
      [{ mimeType: "application/pdf", fileSize: 20_000, bytes: "GIF89a…" }, "rejectedMedia"],
    ] as const;
    for (const [media, textKey] of cases) {
      const world = await waWorld();
      const live = goLive(world, media);
      const summary = await processWhatsAppEvent(liveEvent("sns-document.json", { MIME: "application/pdf", MEDIA_ID }), live.deps);
      expect(summary.records[0]?.messages[0]?.outcome).toBe("MEDIA_REJECTED");
      expect(world.media.objects.has(LIVE_KEY)).toBe(false);
      expect(world.replies).toMatchObject([{ textKey, body: importerEsAR[textKey] }]);
      expect(world.events).toEqual([]);
      expect(await pendingScans(world)).toEqual([]);
      live.sdk.restore();
    }
  });

  it("[FL-090] a document that does not say it is a PDF is never downloaded", async () => {
    const world = await waWorld();
    const live = goLive(world, { mimeType: "application/pdf", fileSize: 1_000 });
    const summary = await processWhatsAppEvent(liveEvent("sns-document.json", { MIME: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", MEDIA_ID }), live.deps);
    expect(summary.records[0]?.messages[0]?.outcome).toBe("MEDIA_REJECTED");
    expect(live.sdk.commandCalls(GetWhatsAppMessageMediaCommand)).toHaveLength(0);
    expect((await firstInbound(world))?.attachments).toMatchObject([{ status: "REJECTED", reason: "NOT_PDF" }]);
    live.sdk.restore();
  });

  it("a simulated media reference is refused by the live transport", async () => {
    const world = await waWorld();
    const live = goLive(world, { mimeType: "application/pdf", fileSize: 1_000 });
    await expect(live.deps.transport.fetchMedia({ mediaId: `sim-media:${SIM_KEY}`, wamid: LIVE_WAMID, clockId: CLOCK })).rejects.toMatchObject({ code: "INVALID" });
    expect(live.sdk.commandCalls(GetWhatsAppMessageMediaCommand)).toHaveLength(0);
    live.sdk.restore();
  });
});
