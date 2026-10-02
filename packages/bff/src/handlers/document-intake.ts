// Lambda entry of `DocumentIntake` (docs/architecture-integrations.md §7, docs/architecture.md §7 and
// §11): the target of the rule infra/operations.ts puts on the default bus for GuardDuty's "Object
// Scan Result" over `Uploads` and `Media`. The decision rests on the EventBridge event, never on the
// object's tag (an uploader cannot pre-set it).
//
//   any result but `NO_THREATS_FOUND`   discarded: `THREATS_FOUND` counted in `MalwareFindings` and
//                                       audited on the operation it belongs to; the pending scan closed
//   `Media` (WhatsApp, phone simulator) channels/whatsapp/media.ts `markMediaScanClean`: the clean mark,
//                                       the intake if the adapter already routed the object, the pending
//                                       scan closed
//   `Uploads` (upload link)             the key parses and was presigned for its token (`UPLOAD_PRESIGN`),
//                                       the link is still valid for it, the object is a PDF (`%PDF-`) of at
//                                       most 10 MB; then `INTAKE_DOCUMENT` (`source UPLOAD_LINK`, eventId
//                                       derived from the key) and `AGENT_TURN(UPLOAD_COMPLETED)` behind it
//                                       in the same FIFO group; a refusal is one `DENY UPLOAD_*` per link
//                                       and variant (FL-010)
//
// Whatever the outcome, an upload ends with `IDEMP#UPLOAD_SCANNED#<key>` and its `ScanPending` closed,
// after the events are in flight (public-web/links.ts contract), so the world is never left busy.
import { z } from "zod";
import { parseUploadKey } from "@legajo/shared";
import { type ChannelEventSink, IntakeDocumentEvent, channelEvent, countMetric, derivedEventId, turnEventId } from "../channels/adapter";
import { markMediaScanClean, mediaRouteOf, scanKeyOf as mediaScanKeyOf } from "../channels/whatsapp/media";
import { s3MediaStore } from "../channels/whatsapp/media-store";
import type { MediaStore } from "../channels/whatsapp/transport";
import { type Connector, connector } from "../connector/index";
import { MAX_DOCUMENT_BYTES } from "../domain/documents";
import type { UploadLink } from "../domain/runtime";
import { simNowOf } from "../lib/clock";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";
import { bucketName } from "../lib/resource";
import { recordDenial, type UploadDenial } from "../public-web/audit";
import { UPLOAD_MARK, issuedDocType, markId, scanKeyOf } from "../public-web/links";
import { linkedQueueSink } from "../worker/sink";

export const MALWARE_FINDINGS_METRIC = "MalwareFindings";
/** Audit action of an object GuardDuty found a threat in. */
export const MALWARE_FOUND_ACTION = "MALWARE_FOUND";
/** A link stays valid for an upload presigned before it expired: presign TTL plus the scan's own delay. */
export const LINK_GRACE_MS = 15 * 60 * 1000;

const ScanResultEvent = z
  .object({
    source: z.literal("aws.guardduty"),
    "detail-type": z.literal("GuardDuty Malware Protection Object Scan Result"),
    detail: z
      .object({
        scanStatus: z.string().optional(),
        resourceType: z.string().optional(),
        s3ObjectDetails: z.object({ bucketName: z.string().min(3).max(63), objectKey: z.string().min(1).max(1_024) }).loose(),
        scanResultDetails: z.object({ scanResultStatus: z.string().min(1).max(64) }).loose(),
      })
      .loose(),
  })
  .loose();

export type IntakeOutcome = "ENQUEUED" | "AWAITING_ROUTE" | "DISCARDED" | "REFUSED" | "IGNORED" | "INVALID";

export interface DocumentIntakeDeps {
  readonly data: Connector;
  readonly events: ChannelEventSink;
  /** Physical names of the two protected buckets. */
  readonly buckets: { readonly uploads: () => string; readonly media: () => string };
  /** `Uploads` read access: size, `%PDF-` and SHA-256 (no deletion: the bucket's lifecycle does that). */
  readonly uploads: Pick<MediaStore, "head" | "digest">;
  readonly wallClock: () => Date;
  readonly log: Logger;
}

interface UploadContext {
  readonly key: string;
  readonly link: UploadLink;
  readonly atSim: string;
}

/** The upload is done with: the scan mark claimed and its pending scan closed (both idempotent). */
async function closeUpload(deps: DocumentIntakeDeps, key: string, clockId: string | undefined): Promise<void> {
  await deps.data.runtime.claimIdempotency({ source: UPLOAD_MARK.scanned, id: markId.scanned(key), atReal: deps.wallClock().toISOString() });
  if (clockId !== undefined) await deps.data.world.closeScanPending(clockId, scanKeyOf(key));
}

async function refuse(deps: DocumentIntakeDeps, upload: UploadContext, denial: UploadDenial, reason: string, detail: Readonly<Record<string, unknown>> = {}): Promise<IntakeOutcome> {
  const correlationId = newCorrelationId();
  await recordDenial({ data: deps.data, log: deps.log, correlationId, now: deps.wallClock() }, { link: upload.link, atSim: upload.atSim }, { denial, reason, ruleIds: ["LAM-ATTACHMENT"], detail: { docType: parseUploadKey(upload.key)?.docType, ...detail } });
  await closeUpload(deps, upload.key, upload.link.clockId);
  return "REFUSED";
}

/** The link of an upload key and the world's "now", or `undefined` when there is none to charge it to. */
async function uploadContext(deps: DocumentIntakeDeps, key: string): Promise<UploadContext | undefined> {
  const parsed = parseUploadKey(key);
  if (parsed === undefined) return undefined;
  const link = await deps.data.runtime.getUploadLink(parsed.token);
  if (link === undefined) return undefined;
  const clock = await deps.data.world.findClock(link.clockId);
  if (clock === undefined) return undefined;
  return { key, link, atSim: simNowOf(clock, deps.wallClock().getTime()).toISOString() };
}

async function auditThreat(deps: DocumentIntakeDeps, target: { readonly firmId: string; readonly clockId: string; readonly operationId: string; readonly atSim: string }, store: "UPLOADS" | "MEDIA", status: string): Promise<void> {
  await deps.data.audit.record({
    firmId: target.firmId,
    clockId: target.clockId,
    operationId: target.operationId,
    decision: "DENY",
    action: MALWARE_FOUND_ACTION,
    ruleIds: ["LAM-ATTACHMENT"],
    actor: "SYSTEM",
    refs: { operationId: target.operationId },
    atSim: target.atSim,
    atReal: deps.wallClock().toISOString(),
    reason: `malware scan result ${status}: the file never reaches the dossier`,
    detail: { store, scanResultStatus: status },
  });
}

/** A scan that is not clean: nothing reaches the intake; a threat is counted and audited. */
async function discard(deps: DocumentIntakeDeps, store: "UPLOADS" | "MEDIA", key: string, status: string): Promise<IntakeOutcome> {
  const threat = status === "THREATS_FOUND";
  if (threat) countMetric(deps.log, MALWARE_FINDINGS_METRIC, { store });
  else deps.log.warn("document_intake.scan_not_clean", { store, status });
  if (store === "UPLOADS") {
    const upload = await uploadContext(deps, key);
    if (upload !== undefined && threat) await auditThreat(deps, { firmId: upload.link.firmId, clockId: upload.link.clockId, operationId: upload.link.operationId, atSim: upload.atSim }, store, status);
    await closeUpload(deps, key, upload?.link.clockId);
    return "DISCARDED";
  }
  const route = await mediaRouteOf(deps.data, key);
  if (route !== undefined) {
    if (threat) await auditThreat(deps, { firmId: route.firmId, clockId: route.clockId, operationId: route.operationId, atSim: route.eventAtSim }, store, status);
    await deps.data.world.closeScanPending(route.clockId, mediaScanKeyOf(key));
  }
  return "DISCARDED";
}

/** A clean object of `Uploads`: validated, then its intake and the link's turn enqueued. */
async function intakeUpload(deps: DocumentIntakeDeps, key: string): Promise<IntakeOutcome> {
  const upload = await uploadContext(deps, key);
  if (upload === undefined) {
    deps.log.warn("document_intake.upload_unknown");
    await closeUpload(deps, key, undefined);
    return "IGNORED";
  }
  const { link } = upload;
  const docType = await issuedDocType(deps.data, link, key);
  if (docType === undefined) return refuse(deps, upload, "UPLOAD_FOREIGN_KEY", "object key not issued for this link");
  if (Date.parse(link.expiresAtReal) + LINK_GRACE_MS <= deps.wallClock().getTime()) return refuse(deps, upload, "UPLOAD_LINK_EXPIRED", "the upload link expired before the file was scanned");
  const head = await deps.uploads.head(key);
  if (head === undefined) {
    await closeUpload(deps, key, link.clockId);
    return "IGNORED";
  }
  if (head.sizeBytes < 1 || head.sizeBytes > MAX_DOCUMENT_BYTES) return refuse(deps, upload, "UPLOAD_TOO_LARGE", "the file is empty or over 10 MB", { sizeBytes: head.sizeBytes });
  const digest = await deps.uploads.digest(key);
  if (!digest.isPdf) return refuse(deps, upload, "UPLOAD_NOT_PDF", "the file does not start with %PDF-");
  if (digest.sizeBytes > MAX_DOCUMENT_BYTES) return refuse(deps, upload, "UPLOAD_TOO_LARGE", "the file is over 10 MB", { sizeBytes: digest.sizeBytes });

  const base = { operationId: link.operationId, clockId: link.clockId, firmId: link.firmId, eventAtSim: upload.atSim };
  const intake = IntakeDocumentEvent.parse({
    ...base,
    type: "INTAKE_DOCUMENT",
    eventId: derivedEventId("INTAKE_DOCUMENT", key),
    source: { party: "IMPORTER", channel: "UPLOAD_LINK", uploadToken: link.token },
    object: { store: "UPLOADS", key },
    sha256: digest.sha256,
    sizeBytes: digest.sizeBytes,
    declaredDocType: docType,
  });
  await deps.events.enqueue(intake);
  await deps.events.enqueue(channelEvent({ ...base, type: "AGENT_TURN", eventId: turnEventId("UPLOAD_COMPLETED", key), trigger: "UPLOAD_COMPLETED", intakeEventIds: [intake.eventId] }));
  await closeUpload(deps, key, link.clockId);
  deps.log.info("document_intake.enqueued", { operationId: link.operationId, docType });
  return "ENQUEUED";
}

export async function processScanResult(raw: unknown, deps: DocumentIntakeDeps): Promise<IntakeOutcome> {
  const parsed = ScanResultEvent.safeParse(raw);
  if (!parsed.success) {
    deps.log.warn("document_intake.invalid_event", { issues: parsed.error.issues.length });
    return "INVALID";
  }
  const { s3ObjectDetails, scanResultDetails } = parsed.data.detail;
  const store = s3ObjectDetails.bucketName === deps.buckets.uploads() ? "UPLOADS" : s3ObjectDetails.bucketName === deps.buckets.media() ? "MEDIA" : undefined;
  if (store === undefined) {
    deps.log.warn("document_intake.foreign_bucket");
    return "IGNORED";
  }
  const key = s3ObjectDetails.objectKey;
  if (scanResultDetails.scanResultStatus !== "NO_THREATS_FOUND") return discard(deps, store, key, scanResultDetails.scanResultStatus);
  if (store === "MEDIA") return markMediaScanClean(deps.data, deps.events, { objectKey: key, atReal: deps.wallClock().toISOString() });
  return intakeUpload(deps, key);
}

export type DocumentIntakeHandler = (event: unknown) => Promise<{ readonly status: IntakeOutcome }>;

export function createDocumentIntakeHandler(depsFor: (log: Logger) => DocumentIntakeDeps, newLog: () => Logger = () => createLogger({ correlationId: newCorrelationId(), bindings: { service: "document-intake" } })): DocumentIntakeHandler {
  return async (event) => {
    const log = newLog();
    return { status: await processScanResult(event, depsFor(log)) };
  };
}

let uploadsStore: MediaStore | undefined;

function stageDeps(log: Logger): DocumentIntakeDeps {
  const data = connector();
  return {
    data,
    events: linkedQueueSink(data.world),
    buckets: { uploads: () => bucketName("Uploads"), media: () => bucketName("Media") },
    uploads: (uploadsStore ??= s3MediaStore({ bucket: bucketName("Uploads") })),
    wallClock: () => new Date(),
    log,
  };
}

export const handler: DocumentIntakeHandler = createDocumentIntakeHandler(stageDeps);
