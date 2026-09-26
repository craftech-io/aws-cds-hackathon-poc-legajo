// The two S3 objects the inbound email path touches (docs/architecture.md §6 and §14): the raw MIME
// that the receipt rule wrote under the `ops` route of the mail bucket (`Resource.InboundMailOps`:
// bucket name and prefix, read only), and the quarantine copy of an untrusted sender's PDF under
// `Documents/quarantine/<operationId>/<messageId>/<n>.pdf` or its `qa/<runId>/` form
// (`Resource.DocumentsQuarantine`: the only prefix of `Documents` `InboundEmail` may write). Names come
// from the links (`Resource`, never `process.env`); every call has its deadline and the SDK's retries.
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { ChannelError } from "@legajo/shared";
import { awsClientConfig } from "../../lib/clients";
import { readLinked } from "../../lib/resource";
import { INBOUND_MAIL_OPS_LINK, MAIL_STORE_TIMEOUTS, MAX_RAW_MAIL_BYTES, PDF_CONTENT_TYPE, QUARANTINE_LINK, SES_REGION } from "./config";

export interface MailStore {
  /** Key of the raw MIME of a received mail (`<stage>/ops/<sesMessageId>`); the intake reads it again. */
  rawKey(sesMessageId: string): string;
  /** The raw MIME; `ChannelError PARSE_FAILED` when it is missing or too large. */
  readRaw(sesMessageId: string): Promise<Uint8Array>;
  /** Writes one quarantined PDF (idempotent: the key is built from the operation, message and index). */
  putQuarantine(key: string, bytes: Uint8Array): Promise<void>;
}

/** A bucket and the prefix a link grants. */
export const PrefixedBucket = z.object({ name: z.string().min(1), prefix: z.string().regex(/^[a-z0-9/-]*$/) });
export type PrefixedBucket = z.infer<typeof PrefixedBucket>;

const SES_MESSAGE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const QUARANTINE_KEY = /^(?:qa\/[A-Za-z0-9][A-Za-z0-9._=+-]*\/)?quarantine\//;

export interface S3MailStoreOptions {
  readonly inbound?: () => PrefixedBucket;
  readonly quarantine?: () => PrefixedBucket;
  readonly client?: S3Client;
}

export function s3MailStore(options: S3MailStoreOptions = {}): MailStore {
  const inbound = options.inbound ?? (() => readLinked(INBOUND_MAIL_OPS_LINK, PrefixedBucket));
  const quarantine = options.quarantine ?? (() => readLinked(QUARANTINE_LINK, PrefixedBucket));
  let client = options.client;
  const s3 = (): S3Client => (client ??= new S3Client({ region: SES_REGION, ...awsClientConfig(MAIL_STORE_TIMEOUTS) }));

  const rawKey = (sesMessageId: string): string => {
    if (!SES_MESSAGE_ID.test(sesMessageId)) throw new RangeError("unsafe SES message id");
    return `${inbound().prefix}${sesMessageId}`;
  };

  return {
    rawKey,

    async readRaw(sesMessageId) {
      try {
        const object = await s3().send(new GetObjectCommand({ Bucket: inbound().name, Key: rawKey(sesMessageId) }));
        if ((object.ContentLength ?? 0) > MAX_RAW_MAIL_BYTES) throw new ChannelError("PARSE_FAILED", "EMAIL", "raw mail too large");
        const bytes = await object.Body?.transformToByteArray();
        if (bytes === undefined) throw new ChannelError("PARSE_FAILED", "EMAIL", "raw mail without a body");
        return bytes;
      } catch (error) {
        if (error instanceof NoSuchKey) throw new ChannelError("PARSE_FAILED", "EMAIL", "raw mail not found", { cause: error });
        if (error instanceof ChannelError) throw error;
        throw new ChannelError("UNAVAILABLE", "EMAIL", "could not read the raw mail", { cause: error });
      }
    },

    async putQuarantine(key, bytes) {
      if (!QUARANTINE_KEY.test(key)) throw new RangeError("only quarantine keys are written here");
      try {
        await s3().send(new PutObjectCommand({ Bucket: quarantine().name, Key: key, Body: bytes, ContentType: PDF_CONTENT_TYPE }));
      } catch (error) {
        throw new ChannelError("UNAVAILABLE", "EMAIL", "could not quarantine an attachment", { cause: error });
      }
    },
  };
}
