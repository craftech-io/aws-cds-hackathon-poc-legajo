import { beforeEach, describe, expect, it } from "vitest";
import { derivedEventId } from "../channels/adapter";
import { CLOCK, type EmailWorld, FIRM, REAL_NOW, emailWorld } from "../channels/email/testing";
import { routeMedia, scanKeyOf as mediaScanKeyOf } from "../channels/whatsapp/media";
import { sha256Hex } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { UPLOAD_MARK, scanKeyOf, uploadObjectKey } from "../public-web/links";
import type { UploadLink } from "../domain/runtime";
import { type DocumentIntakeDeps, MALWARE_FINDINGS_METRIC, createDocumentIntakeHandler } from "./document-intake";

const UPLOADS = "aws-cds-hackathon-poc-legajo-uploads-776805327629";
const MEDIA = "aws-cds-hackathon-poc-legajo-media-776805327629";
const TOKEN = "Zk3pQ8vR2mX7nB4cL9sT1wY6hJ0dF5gA8eK2uI3oP7q";
const UUID = "3f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

let world: EmailWorld;
let lines: string[];
let objects: Map<string, Uint8Array>;
let link: UploadLink;

beforeEach(async () => {
  world = await emailWorld();
  lines = [];
  objects = new Map();
  link = await world.stores.connector.runtime.putUploadLink({
    token: TOKEN,
    operationId: "op-4471",
    importerId: "imp-norpampa",
    firmId: FIRM,
    clockId: CLOCK,
    docTypes: ["CERTIFICATE_OF_ORIGIN", "PACKING_LIST"],
    createdAtReal: REAL_NOW,
    expiresAtReal: "2026-09-29T15:00:00.000Z",
    expiresAt: 1_790_000_000,
  });
});

function handler(now = REAL_NOW) {
  const log = createLogger({ level: "debug", sink: (line) => lines.push(line), now: () => new Date(now) });
  const deps: DocumentIntakeDeps = {
    data: world.stores.connector,
    events: world.sink,
    buckets: { uploads: () => UPLOADS, media: () => MEDIA },
    uploads: {
      head: async (key) => {
        const bytes = objects.get(key);
        return bytes === undefined ? undefined : { sizeBytes: bytes.length, contentType: "application/pdf" };
      },
      digest: async (key) => {
        const bytes = objects.get(key) ?? new Uint8Array();
        return { sha256: sha256Hex(bytes), isPdf: new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-", sizeBytes: bytes.length };
      },
    },
    wallClock: () => new Date(now),
    log,
  };
  return createDocumentIntakeHandler(() => deps, () => log);
}

function scanResult(bucket: string, key: string, status = "NO_THREATS_FOUND"): unknown {
  return {
    version: "0",
    id: "0c1d2e3f-0000-4c1d-8e3f-000000000001",
    "detail-type": "GuardDuty Malware Protection Object Scan Result",
    source: "aws.guardduty",
    account: "776805327629",
    time: "2026-09-26T15:00:05Z",
    region: "us-east-1",
    detail: {
      schemaVersion: "1.0",
      scanStatus: "COMPLETED",
      resourceType: "S3_OBJECT",
      s3ObjectDetails: { bucketName: bucket, objectKey: key, eTag: "abc", versionId: "v1", s3Throttled: false },
      scanResultDetails: { scanResultStatus: status, threats: status === "THREATS_FOUND" ? [{ name: "EICAR-Test-File" }] : null },
    },
  };
}

/** An object the page presigned for the link, uploaded, with the `ScanPending` "Listo" opened. */
async function uploaded(docType: "CERTIFICATE_OF_ORIGIN" | "PACKING_LIST", bytes: Uint8Array = PDF, presigned = true): Promise<string> {
  const key = uploadObjectKey(link, docType, UUID);
  objects.set(key, bytes);
  if (presigned) await world.stores.connector.runtime.claimIdempotency({ source: UPLOAD_MARK.presign, id: key, atReal: REAL_NOW, result: { docType } });
  await world.stores.connector.world.putScanPending({ clockId: CLOCK, scanKey: scanKeyOf(key), bucket: "Uploads", objectKey: key, operationId: "op-4471", createdAtReal: REAL_NOW });
  return key;
}

const pendingScans = async () => (await world.stores.connector.world.listPending(CLOCK)).scans;
const scannedMark = (key: string) => world.stores.connector.runtime.getIdempotency(UPLOAD_MARK.scanned, key);
const denials = async () => (await world.stores.connector.audit.listByOperation("op-4471")).filter((decision) => decision.decision === "DENY").map((decision) => decision.action);

describe("DocumentIntake: upload link", () => {
  it("[FL-009] a clean PDF of the link: INTAKE_DOCUMENT (UPLOAD_LINK) and the UPLOAD_COMPLETED turn in flight, then the scan closed", async () => {
    const key = await uploaded("CERTIFICATE_OF_ORIGIN");
    expect(await handler()(scanResult(UPLOADS, key))).toEqual({ status: "ENQUEUED" });
    const [intake, turn] = world.sink.events;
    expect(intake).toMatchObject({
      type: "INTAKE_DOCUMENT",
      eventId: derivedEventId("INTAKE_DOCUMENT", key),
      operationId: "op-4471",
      source: { party: "IMPORTER", channel: "UPLOAD_LINK", uploadToken: TOKEN },
      object: { store: "UPLOADS", key },
      sha256: sha256Hex(PDF),
      sizeBytes: PDF.length,
      declaredDocType: "CERTIFICATE_OF_ORIGIN",
    });
    expect(turn).toMatchObject({ type: "AGENT_TURN", trigger: "UPLOAD_COMPLETED", intakeEventIds: [intake?.eventId] });
    expect((await world.stores.connector.world.getOpState("op-4471"))?.inFlight).toHaveLength(2);
    expect(await pendingScans()).toEqual([]);
    expect(await scannedMark(key)).toBeDefined();
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("[FL-010] a key that was never presigned for the token is discarded with DENY UPLOAD_FOREIGN_KEY", async () => {
    const key = await uploaded("PACKING_LIST", PDF, false);
    expect(await handler()(scanResult(UPLOADS, key))).toEqual({ status: "REFUSED" });
    expect(world.sink.events).toEqual([]);
    expect(await denials()).toEqual(["UPLOAD_FOREIGN_KEY"]);
    expect(await pendingScans()).toEqual([]);
  });

  it("[FL-010] a file that does not start with %PDF- is refused with DENY UPLOAD_NOT_PDF", async () => {
    const key = await uploaded("PACKING_LIST", new TextEncoder().encode("GIF89a not a pdf"));
    expect(await handler()(scanResult(UPLOADS, key))).toEqual({ status: "REFUSED" });
    expect(world.sink.events).toEqual([]);
    expect(await denials()).toEqual(["UPLOAD_NOT_PDF"]);
  });

  it("a link that expired well before the scan refuses the upload", async () => {
    const key = await uploaded("PACKING_LIST");
    expect(await handler("2026-09-29T16:00:00.000Z")(scanResult(UPLOADS, key))).toEqual({ status: "REFUSED" });
    expect(await denials()).toEqual(["UPLOAD_LINK_EXPIRED"]);
  });

  it("only NO_THREATS_FOUND reaches the intake: a threat is counted, audited and its scan closed", async () => {
    const key = await uploaded("PACKING_LIST");
    expect(await handler()(scanResult(UPLOADS, key, "THREATS_FOUND"))).toEqual({ status: "DISCARDED" });
    expect(world.sink.events).toEqual([]);
    expect(lines.filter((line) => line.includes(`"metric":"${MALWARE_FINDINGS_METRIC}"`))).toHaveLength(1);
    expect(await denials()).toEqual(["MALWARE_FOUND"]);
    expect(await pendingScans()).toEqual([]);
    expect(await scannedMark(key)).toBeDefined();
  });

  it("an UNSUPPORTED or FAILED scan is not clean either, without a malware finding", async () => {
    const key = await uploaded("PACKING_LIST");
    expect(await handler()(scanResult(UPLOADS, key, "FAILED"))).toEqual({ status: "DISCARDED" });
    expect(world.sink.events).toEqual([]);
    expect(lines.some((line) => line.includes(`"metric":"${MALWARE_FINDINGS_METRIC}"`))).toBe(false);
  });
});

describe("DocumentIntake: Media (WhatsApp and the phone simulator)", () => {
  const MEDIA_KEY = "sim/msg-in00000001/1.pdf";
  const route = { objectKey: MEDIA_KEY, sha256: sha256Hex(PDF), sizeBytes: PDF.length, operationId: "op-4471", clockId: CLOCK, firmId: FIRM, messageId: "msg-in00000001", eventAtSim: "2026-10-15T22:10:00.000Z" };

  it("[FL-017] a clean object the adapter already routed enqueues its intake and closes the pending scan", async () => {
    expect(await routeMedia(world.stores.connector, world.sink, route, REAL_NOW)).toBe("AWAITING_SCAN");
    expect(await handler()(scanResult(MEDIA, MEDIA_KEY))).toEqual({ status: "ENQUEUED" });
    expect(world.sink.events).toMatchObject([{ type: "INTAKE_DOCUMENT", object: { store: "MEDIA", key: MEDIA_KEY }, source: { channel: "WHATSAPP" } }]);
    expect((await pendingScans()).map((scan) => scan.scanKey)).not.toContain(mediaScanKeyOf(MEDIA_KEY));
  });

  it("a clean result before the route is recorded; the adapter enqueues when it routes", async () => {
    expect(await handler()(scanResult(MEDIA, MEDIA_KEY))).toEqual({ status: "AWAITING_ROUTE" });
    expect(world.sink.events).toEqual([]);
    expect(await routeMedia(world.stores.connector, world.sink, route, REAL_NOW)).toBe("ENQUEUED");
    expect(world.sink.events).toHaveLength(1);
  });

  it("a threat in a routed object never reaches the intake", async () => {
    await routeMedia(world.stores.connector, world.sink, route, REAL_NOW);
    expect(await handler()(scanResult(MEDIA, MEDIA_KEY, "THREATS_FOUND"))).toEqual({ status: "DISCARDED" });
    expect(world.sink.events).toEqual([]);
    expect(await pendingScans()).toEqual([]);
  });
});

describe("DocumentIntake: what is not a scan result of our buckets", () => {
  it("drops another bucket and a malformed event", async () => {
    expect(await handler()(scanResult("someone-elses-bucket", "x.pdf"))).toEqual({ status: "IGNORED" });
    expect(await handler()({ source: "aws.guardduty", detail: {} })).toEqual({ status: "INVALID" });
    expect(world.sink.events).toEqual([]);
  });
});
