// Object keys of the Documents, Uploads, Media and Seed buckets (docs/architecture.md §6): the one
// place the intake, the upload page, the phone simulator, the world factory, the seed loader and the
// `QaDriver` agree on them. Keys are always built by code, never from an external file name. In QA
// worlds every key of Documents, Uploads and Media carries the `qa/<runId>/` prefix (the only prefix
// the `QaDriver` may delete). In guest worlds every key of Documents and Media carries
// `guest/<pub|res>/<firmId>/e<epoch>/` (ADR-0015 §4): destroying a world deletes that prefix, and the
// lifecycle rule of `guest/pub/` is the backstop.
import { z } from "zod";
import { type GuestKind } from "./enums";
import { DocType } from "./enums-dossier";
import { FirmId, padVersion } from "./ids";

// Ids of our own and of AWS or Meta (a live `wamid` is base64, so `=` and `+` appear); never a slash.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._=+-]*$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_ONLY = new RegExp(`^${UUID}$`);
const DOC_TYPES = DocType.options.join("|");

function segment(value: string | number): string {
  const text = String(value);
  if (!SAFE_SEGMENT.test(text)) throw new RangeError(`unsafe key segment "${text}"`);
  return text;
}

function sha8(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new RangeError("expected a hex SHA-256");
  return sha256.slice(0, 8);
}

/** `qa/<runId>/<key>` in a QA world, the key unchanged elsewhere. */
export function worldKey(key: string, qaRunId?: string): string {
  return qaRunId === undefined ? key : `qa/${segment(qaRunId)}/${key}`;
}

/** The guest world a Documents or Media key belongs to (ADR-0015 §4). */
export interface GuestKeyScope {
  readonly guestKind: GuestKind;
  readonly firmId: string;
  /** World epoch of the clock: a reset or a new owner of the slot writes under a new prefix. */
  readonly epoch: number;
}

const GUEST_ACCESS: Readonly<Record<GuestKind, "pub" | "res">> = { PUBLIC: "pub", RESERVED: "res" };

/** `guest/pub/firm-guest-41/e3/`: everything a guest world wrote, deleted whole by `destroyWorld`. */
export function guestWorldPrefix(scope: GuestKeyScope): string {
  if (!Number.isInteger(scope.epoch) || scope.epoch < 1) throw new RangeError(`invalid world epoch ${scope.epoch}`);
  return `guest/${GUEST_ACCESS[scope.guestKind]}/${segment(FirmId.parse(scope.firmId))}/e${scope.epoch}/`;
}

/** `<key>` of a guest world under its prefix. */
export function guestKey(key: string, scope: GuestKeyScope): string {
  return `${guestWorldPrefix(scope)}${key}`;
}

const GUEST_PREFIX = /^guest\/(pub|res)\/(firm-[a-z0-9]+(?:-[a-z0-9]+)*)\/e([1-9][0-9]*)\/(.+)$/;

/** The guest scope of a key, or `undefined` for a key of any other world. */
export function parseGuestKey(key: string): (GuestKeyScope & { readonly rest: string }) | undefined {
  const match = GUEST_PREFIX.exec(key);
  if (!match) return undefined;
  return { guestKind: match[1] === "pub" ? "PUBLIC" : "RESERVED", firmId: match[2] ?? "", epoch: Number(match[3]), rest: match[4] ?? "" };
}

function splitWorldKey(key: string): { qaRunId?: string; guest?: GuestKeyScope; rest: string } {
  const guest = parseGuestKey(key);
  if (guest !== undefined) return { guest: { guestKind: guest.guestKind, firmId: guest.firmId, epoch: guest.epoch }, rest: guest.rest };
  const match = /^qa\/([A-Za-z0-9][A-Za-z0-9._=+-]*)\/(.+)$/.exec(key);
  return match ? { qaRunId: match[1] ?? "", rest: match[2] ?? "" } : { rest: key };
}

export const documentsKeys = {
  /** Every received version: `ops/<operationId>/<docType>/v<nnn>-<sha8>.pdf`. */
  version: (operationId: string, docType: DocType, versionNo: number, sha256: string): string =>
    `ops/${segment(operationId)}/${DocType.parse(docType)}/v${padVersion(versionNo)}-${sha8(sha256)}.pdf`,
  /** Attachments of an untrusted email. */
  quarantine: (operationId: string, messageId: string, index: number): string => `quarantine/${segment(operationId)}/${segment(messageId)}/${segment(index)}.pdf`,
  /** A version the reader did not recognize, waiting for the broker to classify or discard it. */
  unrecognized: (operationId: string, docVersionId: string): string => `unrecognized/${segment(operationId)}/${segment(docVersionId)}.pdf`,
} as const;

/** An upload link token is base64url: it may start with `-` or `_`, which a generic segment may not. */
function tokenSegment(token: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new RangeError("expected a base64url upload token");
  return token;
}

export const uploadsKeys = {
  /** Prefix a pre-signed POST of the upload link may write under. */
  linkPrefix: (token: string): string => `uploads/${tokenSegment(token)}/`,
  object: (token: string, docType: DocType, uuid: string): string => {
    if (!UUID_ONLY.test(uuid)) throw new RangeError("expected a lower-case UUID");
    return `uploads/${tokenSegment(token)}/${DocType.parse(docType)}/${uuid}.pdf`;
  },
} as const;

export const mediaKeys = {
  /** Media of a live WhatsApp message, downloaded by `GetWhatsAppMessageMedia`. */
  whatsapp: (wamid: string, mediaId: string): string => `wa/${segment(wamid)}/${segment(mediaId)}`,
  /** A PDF attached from the phone simulator. */
  simulator: (messageId: string, index: number): string => `sim/${segment(messageId)}/${segment(index)}.pdf`,
} as const;

export interface UploadKey {
  readonly qaRunId?: string;
  readonly token: string;
  readonly docType: DocType;
  readonly uuid: string;
}

const UPLOAD_OBJECT = new RegExp(`^uploads/([A-Za-z0-9_-]+)/(${DOC_TYPES})/(${UUID})\\.pdf$`);

/** Parses an object key of Uploads; `DocumentIntake` then checks the token is live and owns the key. */
export function parseUploadKey(key: string): UploadKey | undefined {
  const { qaRunId, guest, rest } = splitWorldKey(key);
  // Upload links write `uploads/<token>/…` in every world; the link row names the world.
  const match = guest === undefined ? UPLOAD_OBJECT.exec(rest) : null;
  if (!match) return undefined;
  const parsed = { token: match[1] ?? "", docType: DocType.parse(match[2]), uuid: match[3] ?? "" };
  return qaRunId === undefined ? parsed : { qaRunId, ...parsed };
}

export interface SimMediaKey {
  readonly qaRunId?: string;
  readonly guest?: GuestKeyScope;
  readonly messageId: string;
  readonly index: number;
}

const SIM_MEDIA_OBJECT = /^sim\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(\d+)\.pdf$/;

export function parseSimMediaKey(key: string): SimMediaKey | undefined {
  const { qaRunId, guest, rest } = splitWorldKey(key);
  const match = SIM_MEDIA_OBJECT.exec(rest);
  if (!match) return undefined;
  const parsed = { messageId: match[1] ?? "", index: Number(match[2]) };
  if (guest !== undefined) return { guest, ...parsed };
  return qaRunId === undefined ? parsed : { qaRunId, ...parsed };
}

/**
 * `document.id` of a message from the phone simulator: `sim-media:<key>`. The simulated transport
 * reads that key of Media instead of calling `GetWhatsAppMessageMedia` (docs/architecture-integrations.md §4.2).
 */
export const SIM_MEDIA_REF_PREFIX = "sim-media:";

export function simMediaRef(key: string): string {
  if (parseSimMediaKey(key) === undefined) throw new RangeError("not a phone simulator media key");
  return `${SIM_MEDIA_REF_PREFIX}${key}`;
}

/** The Media key behind a `sim-media:` reference, only if it is a simulator key. */
export function parseSimMediaRef(ref: string): string | undefined {
  if (!ref.startsWith(SIM_MEDIA_REF_PREFIX)) return undefined;
  const key = ref.slice(SIM_MEDIA_REF_PREFIX.length);
  return parseSimMediaKey(key) === undefined ? undefined : key;
}

/** World templates the world factory reads from `Seed/worlds/<template>.json` (docs/seed-spec.md §1). */
export const WorldTemplateName = z.enum(["demo-firm-delta", "demo-firm-norte", "qa-min", "guest", "models"]);
export type WorldTemplateName = z.infer<typeof WorldTemplateName>;

export const seedKeys = {
  /** Synthetic PDF of a model operation, `<templateOperation>` being its operation id (`op-4471`). */
  pdf: (templateOperation: string, docType: DocType, versionNo: number): string => `pdfs/${segment(templateOperation)}/${DocType.parse(docType)}-v${segment(versionNo)}.pdf`,
  unknownPdf: (index: number): string => `pdfs/unknown/${segment(index)}.pdf`,
  worldTemplate: (template: WorldTemplateName): string => `worlds/${WorldTemplateName.parse(template)}.json`,
  readerCatalog: "reader/catalog.json",
  batchInputs: "metrics/batch-inputs.jsonl",
} as const;
