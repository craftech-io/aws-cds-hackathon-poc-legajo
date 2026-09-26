// The `Media` bucket as the WhatsApp adapter uses it: the size and type of an object the phone or
// End User Messaging Social wrote, its SHA-256 and `%PDF-` check (the intake event carries the hash),
// and the deletion of one that exceeds the limits (docs/architecture-integrations.md §4.1: "se borra
// apenas se descarga"). The SDK retries within the timeouts of config.ts.
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { awsClientConfig } from "../../lib/clients";
import { sha256Hex } from "../../lib/crypto";
import { STAGE_REGION } from "../../public-web/presign";
import { startsWithPdfMagic } from "../email/mime";
import { S3_TIMEOUTS } from "./config";
import type { MediaStore } from "./transport";

export interface S3MediaStoreOptions {
  /** Physical name of the `Media` bucket (`bucketName("Media")` in the Lambda). */
  readonly bucket: string;
  readonly client?: S3Client;
}

function isNotFound(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const status = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
  return name === "NotFound" || name === "NoSuchKey" || status === 404;
}

export function s3MediaStore(options: S3MediaStoreOptions): MediaStore {
  let client = options.client;
  const s3 = (): S3Client => (client ??= new S3Client({ region: STAGE_REGION, ...awsClientConfig(S3_TIMEOUTS) }));
  return {
    async head(key) {
      try {
        const output = await s3().send(new HeadObjectCommand({ Bucket: options.bucket, Key: key }));
        return { sizeBytes: output.ContentLength ?? 0, contentType: output.ContentType ?? "application/octet-stream" };
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async digest(key) {
      const output = await s3().send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
      const bytes = output.Body === undefined ? new Uint8Array() : await output.Body.transformToByteArray();
      // `%PDF-` is the only type check we make of a file: reading it belongs to the reader (ADR-0003).
      return { sha256: sha256Hex(bytes), isPdf: startsWithPdfMagic(bytes), sizeBytes: bytes.length };
    },
    async delete(key) {
      await s3().send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
    },
  };
}
