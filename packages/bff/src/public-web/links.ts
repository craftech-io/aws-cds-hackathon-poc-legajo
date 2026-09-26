// The upload link `Runtime/LINK#<token>` as the public page sees it (docs/architecture.md §11): a
// 32-byte token, one importer, one operation, 72 real hours, reusable until every requested document
// arrived. `create_upload_link` writes the row (WP-26); this module decides whether a token opens the
// page, builds the object keys the browser may write and checks the keys it reports back.
//
// Contract with `DocumentIntake` (WP-29), which reads the same marks of `Runtime/IDEMP#`:
//   UPLOAD_PRESIGN  <object key>              written here for every key this page presigned; a key
//                                              without it was never issued for its token
//   UPLOAD_DOC      <sha256(token)>#<docType> written at "Listo" for each document of the session; the
//                                              link is complete (`completedAtReal`) when every
//                                              requested document has one
//   UPLOAD_SCANNED  <object key>              written by `DocumentIntake` once it processed the scan
//                                              result of the key, so a later "Listo" does not open a
//                                              `ScanPending` nobody would close
// At "Listo" the page also writes one `ScanPending` (`PENDING#<clockId>`/`SCAN#<sha8 of the key>`) per
// uploaded key still waiting for its scan; `DocumentIntake` closes it (docs/architecture.md §7).
import { type DocType, parseUploadKey, uploadsKeys, worldKey } from "@legajo/shared";
import type { Connector } from "../connector/index";
import { isExpired } from "../domain/common";
import type { UploadLink } from "../domain/runtime";
import { simNowOf } from "../lib/clock";
import { PUBLIC_TOKEN_PATTERN, sha256Hex } from "../lib/crypto";

export const UPLOAD_MARK = {
  presign: "UPLOAD_PRESIGN",
  doc: "UPLOAD_DOC",
  scanned: "UPLOAD_SCANNED",
  deny: "UPLOAD_DENY",
} as const;

/** Mark ids of `Runtime/IDEMP#<source>#<id>`; the token itself only appears inside an object key. */
export const markId = {
  presign: (objectKey: string): string => objectKey,
  scanned: (objectKey: string): string => objectKey,
  doc: (token: string, docType: DocType): string => `${sha256Hex(token)}#${docType}`,
  deny: (token: string, action: string): string => `${sha256Hex(token)}#${action}`,
} as const;

/** `SCAN#<sha8 of the key>` of the `ScanPending` of an object (docs/architecture.md §7). */
export function scanKeyOf(objectKey: string): string {
  return sha256Hex(objectKey).slice(0, 8);
}

/**
 * Why a token does not open the page. `MALFORMED`, `UNKNOWN` and `WORLD_GONE` say nothing about any
 * operation; `EXPIRED`, `WORLD_RESET` and `USED` belong to a known link and are audited once per link.
 */
export type LinkRefusal = "MALFORMED" | "UNKNOWN" | "WORLD_GONE" | "EXPIRED" | "WORLD_RESET" | "USED";

export interface OpenLink {
  readonly ok: true;
  readonly link: UploadLink;
  /** Simulated "now" of the link's world: the instant of every decision the page records. */
  readonly atSim: string;
  /** Requested documents without an upload confirmed by "Listo" yet, in the link's order. */
  readonly pending: readonly DocType[];
}

export interface RefusedLink {
  readonly ok: false;
  readonly refusal: LinkRefusal;
  /** Present for a link that exists in a world that still exists. */
  readonly known?: { readonly link: UploadLink; readonly atSim: string };
}

export type LinkState = OpenLink | RefusedLink;

/** Documents of the link that "Listo" has not confirmed yet (one read per requested document). */
export async function pendingDocTypes(data: Connector, link: UploadLink): Promise<DocType[]> {
  const confirmed = await Promise.all(link.docTypes.map((docType) => data.runtime.getIdempotency(UPLOAD_MARK.doc, markId.doc(link.token, docType))));
  return link.docTypes.filter((_, index) => confirmed[index] === undefined);
}

/** Resolves a token of the path into an open link or the reason it is refused. `now` is real time. */
export async function resolveLink(data: Connector, token: string, now: Date): Promise<LinkState> {
  if (!PUBLIC_TOKEN_PATTERN.test(token)) return { ok: false, refusal: "MALFORMED" };
  const link = await data.runtime.getUploadLink(token);
  if (link === undefined) return { ok: false, refusal: "UNKNOWN" };
  const clock = await data.world.findClock(link.clockId);
  if (clock === undefined) return { ok: false, refusal: "WORLD_GONE" };
  const known = { link, atSim: simNowOf(clock, now.getTime()).toISOString() };
  if (isExpired(link.expiresAt, now) || Date.parse(link.expiresAtReal) <= now.getTime()) return { ok: false, refusal: "EXPIRED", known };
  // A link of a world reset after it was created points at an operation of a past epoch.
  if (clock.lastResetAtReal !== undefined && Date.parse(clock.lastResetAtReal) > Date.parse(link.createdAtReal)) return { ok: false, refusal: "WORLD_RESET", known };
  if (link.completedAtReal !== undefined) return { ok: false, refusal: "USED", known };
  const pending = await pendingDocTypes(data, link);
  if (pending.length === 0) return { ok: false, refusal: "USED", known };
  return { ok: true, link, atSim: known.atSim, pending };
}

/** Object key of one upload: `uploads/<token>/<docType>/<uuid>.pdf`, under `qa/<runId>/` in a QA run. */
export function uploadObjectKey(link: UploadLink, docType: DocType, uuid: string): string {
  return worldKey(uploadsKeys.object(link.token, docType, uuid), link.runId);
}

/**
 * The document of a key the browser reports after uploading, or `undefined` when the key is not one
 * this link could have been issued: another token, another QA run, a document the link does not ask
 * for, or no `UPLOAD_PRESIGN` mark (docs/flows-catalog.md FL-010 b).
 */
export async function issuedDocType(data: Connector, link: UploadLink, objectKey: string): Promise<DocType | undefined> {
  const parsed = parseUploadKey(objectKey);
  if (parsed === undefined || parsed.token !== link.token || parsed.qaRunId !== link.runId) return undefined;
  if (!link.docTypes.includes(parsed.docType)) return undefined;
  const mark = await data.runtime.getIdempotency(UPLOAD_MARK.presign, markId.presign(objectKey));
  return mark === undefined ? undefined : parsed.docType;
}
