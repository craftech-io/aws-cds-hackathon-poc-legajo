// `source.url` of a reading: a pre-signed GET of one object of the stage's `Documents` bucket, valid
// 5 minutes (docs/architecture-integrations.md §5). The reader downloads with it and holds no S3
// permission of its own; the mock only accepts this exact shape (regional virtual-hosted host of
// `Documents`). Pre-signing is local: no network call, only the caller's credentials.
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { READER_LIMITS, READER_SOURCE_REGION } from "@legajo/reader-contract";

export type SourceUrlSigner = (key: string) => Promise<string>;

export interface SourceUrlSignerOptions {
  /** Physical name of the `Documents` bucket. */
  readonly bucket: string;
  /** Test seam: a client with fixed credentials. */
  readonly s3?: S3Client;
}

export function createSourceUrlSigner(options: SourceUrlSignerOptions): SourceUrlSigner {
  const s3 = options.s3 ?? new S3Client({ region: READER_SOURCE_REGION });
  return async (key) => {
    if (key === "" || key.startsWith("/")) throw new RangeError("expected an object key of Documents");
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: options.bucket, Key: key }), { expiresIn: READER_LIMITS.sourceUrlTtlSeconds });
  };
}
