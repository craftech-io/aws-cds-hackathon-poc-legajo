// The two POSTs of the page on an open link (docs/architecture.md §11):
//
//   presign  {docType, size, contentType} → one pre-signed POST of 5 minutes for
//            `uploads/<token>/<docType>/<uuid>.pdf`, at most 20 per link. The declared type and size
//            only let the page say why before S3 would refuse; S3 enforces the same limits.
//   done     {keys} ("Listo") → checks every key was issued for this link, opens the `ScanPending` of
//            each object still waiting for its malware scan (docs/architecture.md §7), confirms the
//            documents of the session and completes the link once every requested document arrived.
import { z } from "zod";
import { ConnectorError, type DocType } from "@legajo/shared";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { MAX_DOCUMENT_BYTES } from "../domain/documents";
import { MAX_PRESIGNS_PER_LINK } from "../domain/runtime";
import { type AuditContext, recordAccess, recordDenial } from "./audit";
import { confirmationPending } from "./copy";
import { type PublicRequest, jsonError, jsonResponse, parseBody } from "./http";
import { type OpenLink, UPLOAD_MARK, issuedDocType, markId, pendingDocTypes, scanKeyOf, uploadObjectKey } from "./links";
import { PDF_CONTENT_TYPE, PRESIGN_TTL_SECONDS, type PdfPresigner } from "./presign";

type Response = APIGatewayProxyStructuredResultV2;

export interface ActionContext extends AuditContext {
  readonly request: PublicRequest;
  readonly presigner: PdfPresigner;
  readonly newUuid: () => string;
}

const PresignBody = z
  .object({
    docType: z.string().max(64),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentType: z.string().max(128),
  })
  .strict();

const DoneBody = z.object({ keys: z.array(z.string().min(1).max(1024)).min(1).max(MAX_PRESIGNS_PER_LINK) }).strict();

function isConnectorError(error: unknown, code: ConnectorError["code"]): boolean {
  return error instanceof ConnectorError && error.code === code;
}

export async function presign(ctx: ActionContext, open: OpenLink): Promise<Response> {
  const body = parseBody(ctx.request, PresignBody);
  if (!body.ok) return jsonError(400, "INVALID", body.reason);
  const { size, contentType } = body.value;
  const { link } = open;
  const docType = link.docTypes.find((requested) => requested === body.value.docType);
  if (docType === undefined) {
    await recordDenial(ctx, open, { denial: "UPLOAD_DOCTYPE_NOT_REQUESTED", reason: "document the link does not ask for", ruleIds: ["LAM-ATTACHMENT"] });
    return jsonError(403, "FORBIDDEN", "DOCTYPE_NOT_REQUESTED");
  }
  if (contentType.trim().toLowerCase() !== PDF_CONTENT_TYPE) {
    await recordDenial(ctx, open, { denial: "UPLOAD_NOT_PDF", reason: "declared file is not a PDF", detail: { docType } });
    return jsonError(415, "INVALID", "NOT_PDF");
  }
  if (size < 1) return jsonError(400, "INVALID", "EMPTY");
  if (size > MAX_DOCUMENT_BYTES) {
    await recordDenial(ctx, open, { denial: "UPLOAD_TOO_LARGE", reason: "declared file is over 10 MB", detail: { docType } });
    return jsonError(413, "INVALID", "TOO_LARGE");
  }

  const atReal = ctx.now.toISOString();
  try {
    await ctx.data.runtime.recordPresign(link.token, atReal);
  } catch (error) {
    if (isConnectorError(error, "CONFLICT")) {
      await recordDenial(ctx, open, { denial: "UPLOAD_PRESIGN_LIMIT", reason: `more than ${MAX_PRESIGNS_PER_LINK} files for one link`, detail: { docType } });
      return jsonError(409, "CONFLICT", "PRESIGN_LIMIT");
    }
    if (isConnectorError(error, "NOT_FOUND")) return jsonError(404, "NOT_FOUND", "LINK_UNKNOWN");
    throw error;
  }

  const key = uploadObjectKey(link, docType, ctx.newUuid());
  await ctx.data.runtime.claimIdempotency({ source: UPLOAD_MARK.presign, id: markId.presign(key), atReal, result: { docType } });
  const post = await ctx.presigner.presign(key);
  await recordAccess(ctx, open, "UPLOAD_PRESIGNED", { docType });
  return jsonResponse(200, { ok: true, url: post.url, fields: post.fields, key, expiresInSeconds: PRESIGN_TTL_SECONDS });
}

/** Opens the `ScanPending` of an uploaded object unless `DocumentIntake` already saw its scan result. */
async function openScanPending(ctx: ActionContext, open: OpenLink, objectKey: string): Promise<void> {
  const scanned = await ctx.data.runtime.getIdempotency(UPLOAD_MARK.scanned, markId.scanned(objectKey));
  if (scanned !== undefined) return;
  try {
    await ctx.data.world.putScanPending({
      clockId: open.link.clockId,
      scanKey: scanKeyOf(objectKey),
      bucket: "Uploads",
      objectKey,
      operationId: open.link.operationId,
      createdAtReal: ctx.now.toISOString(),
    });
  } catch (error) {
    // "Listo" pressed twice: the first one already opened it.
    if (!isConnectorError(error, "CONFLICT")) throw error;
  }
}

export async function done(ctx: ActionContext, open: OpenLink): Promise<Response> {
  const body = parseBody(ctx.request, DoneBody);
  if (!body.ok) return jsonError(400, "INVALID", body.reason);
  const { link } = open;
  const keys = [...new Set(body.value.keys)];
  const issued = await Promise.all(keys.map((key) => issuedDocType(ctx.data, link, key)));
  if (issued.some((docType) => docType === undefined)) {
    await recordDenial(ctx, open, { denial: "UPLOAD_FOREIGN_KEY", reason: "object key not issued for this link", ruleIds: ["LAM-ATTACHMENT"], detail: { files: keys.length } });
    return jsonError(403, "FORBIDDEN", "FOREIGN_KEY");
  }

  for (const key of keys) await openScanPending(ctx, open, key);
  const received: DocType[] = link.docTypes.filter((docType) => issued.includes(docType));
  const atReal = ctx.now.toISOString();
  for (const docType of received) await ctx.data.runtime.claimIdempotency({ source: UPLOAD_MARK.doc, id: markId.doc(link.token, docType), atReal });
  const pending = await pendingDocTypes(ctx.data, link);
  const completed = pending.length === 0;
  if (completed) await ctx.data.runtime.completeUploadLink(link.token, atReal);
  await recordAccess(ctx, open, "UPLOAD_SESSION_DONE", { docTypes: received, pending, completed, files: keys.length });
  return jsonResponse(200, { ok: true, received, pending, completed, message: confirmationPending(pending) });
}
