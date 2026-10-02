// The S3 side of the intake in the stage (docs/architecture.md §6 and §14, capability of
// `OperationWorker`: `Documents` read and write; `Uploads`, `Media` and the mail bucket read):
//
//   SourceStore    the PDF an `INTAKE_DOCUMENT` names: an accepted attachment of the raw MIME in the
//                  `ops` route of the mail bucket (re-screened and matched by SHA-256,
//                  channels/email/mime.ts), an upload of the link or a WhatsApp media object;
//   DocumentStore  `Documents`, under keys built by code, and the 5-minute GET the reader downloads with.
//
// Bucket names come from the links (`Resource` through lib/resource.ts and the email store), never
// from the environment; every call has its timeout and the SDK's retries.
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { READER_SOURCE_REGION } from "@legajo/reader-contract";
import { ChannelError, type SendChannel } from "@legajo/shared";
import type { IntakeObject } from "../channels/adapter";
import { INBOUND_MAIL_OPS_LINK, MAIL_STORE_TIMEOUTS } from "../channels/email/config";
import { acceptedAttachment } from "../channels/email/mime";
import { PrefixedBucket, s3MailStore } from "../channels/email/store";
import { MAX_DOCUMENT_BYTES } from "../domain/documents";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import { bucketName, readLinked } from "../lib/resource";
import { linkedSourceUrlSigner } from "../reader/linked";
import type { DocumentStore, SourceStore } from "./ports";

/** One PDF of at most 10 MB per call. */
export const INTAKE_S3_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 15_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };

const PDF_CONTENT_TYPE = "application/pdf";

/** The stage's S3 client: one region (the one the reader contract pins `Documents` to). */
function s3Client(timeouts: ClientTimeouts): S3Client {
  return new S3Client({ region: READER_SOURCE_REGION, ...awsClientConfig(timeouts) });
}

const CHANNEL_OF: Readonly<Record<IntakeObject["store"], SendChannel>> = { INBOUND_MAIL: "EMAIL", UPLOADS: "WHATSAPP", MEDIA: "WHATSAPP" };

async function readObject(s3: S3Client, bucket: string, key: string, channel: SendChannel): Promise<Uint8Array> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if ((object.ContentLength ?? 0) > MAX_DOCUMENT_BYTES) throw new ChannelError("INVALID", channel, "object over the intake limit");
    const bytes = await object.Body?.transformToByteArray();
    if (bytes === undefined || bytes.length > MAX_DOCUMENT_BYTES) throw new ChannelError("INVALID", channel, "object without a body or over the intake limit");
    return bytes;
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    if (error instanceof NoSuchKey) throw new ChannelError("INVALID", channel, "object not found", { cause: error });
    throw new ChannelError("UNAVAILABLE", channel, "could not read the object", { cause: error });
  }
}

export interface S3SourceStoreOptions {
  readonly client?: S3Client;
  /** Physical bucket of a store (tests); the links otherwise. */
  readonly bucketOf?: (store: "UPLOADS" | "MEDIA") => string;
  readonly inbound?: () => PrefixedBucket;
}

export function s3SourceStore(options: S3SourceStoreOptions = {}): SourceStore {
  let client = options.client;
  const s3 = (): S3Client => (client ??= s3Client(INTAKE_S3_TIMEOUTS));
  const bucketOf = options.bucketOf ?? ((store: "UPLOADS" | "MEDIA") => bucketName(store === "UPLOADS" ? "Uploads" : "Media"));
  const inbound = options.inbound ?? (() => readLinked(INBOUND_MAIL_OPS_LINK, PrefixedBucket));
  let mail: ReturnType<typeof s3MailStore> | undefined;

  return {
    async read(object, sha256) {
      if (object.store !== "INBOUND_MAIL") return readObject(s3(), bucketOf(object.store), object.key, CHANNEL_OF[object.store]);
      const { prefix } = inbound();
      if (!object.key.startsWith(prefix)) throw new ChannelError("INVALID", "EMAIL", "raw mail outside the ops route");
      mail ??= s3MailStore({ inbound, client: options.client ?? new S3Client({ region: READER_SOURCE_REGION, ...awsClientConfig(MAIL_STORE_TIMEOUTS) }) });
      const raw = await mail.readRaw(object.key.slice(prefix.length));
      return acceptedAttachment(raw, object.attachmentIndex, sha256);
    },
  };
}

export interface S3DocumentStoreOptions {
  readonly client?: S3Client;
  readonly bucket?: () => string;
  readonly sourceUrl?: (key: string) => Promise<string>;
}

/** `Documents` of the stage: put and delete under code-built keys, and the reader's pre-signed GET. */
export function s3DocumentStore(options: S3DocumentStoreOptions = {}): DocumentStore {
  let client = options.client;
  const s3 = (): S3Client => (client ??= s3Client(INTAKE_S3_TIMEOUTS));
  const bucket = options.bucket ?? (() => bucketName("Documents"));
  const sourceUrl = options.sourceUrl ?? ((key: string) => linkedSourceUrlSigner()(key));
  return {
    async put(key, bytes) {
      await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: bytes, ContentType: PDF_CONTENT_TYPE }));
    },
    async delete(key) {
      await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    },
    sourceUrl,
  };
}
