// Pre-signed POST of one PDF (docs/architecture.md §11): 5 minutes, `content-length-range 1..10 MB`,
// `Content-Type application/pdf` and the exact key (the SDK adds the `key` and `bucket` conditions
// itself). The upload page uses it for `Uploads/uploads/<token>/…` and the phone simulator's
// `presignMedia` for `Media/sim/…`, which docs/architecture.md §11 requires to carry exactly the same
// conditions: both call this module, so they cannot drift apart. S3 enforces the policy; the page only
// adds a friendlier message before asking.
import { S3Client } from "@aws-sdk/client-s3";
import { type PresignedPostOptions, createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { MAX_DOCUMENT_BYTES } from "../domain/documents";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";

export const PDF_CONTENT_TYPE = "application/pdf";

/** Lifetime of one pre-signed POST, in seconds. */
export const PRESIGN_TTL_SECONDS = 5 * 60;

/** Region of the stage (CLAUDE.md, "Cuenta"); a configuration string, never read from the environment. */
export const STAGE_REGION = "us-east-1";

// Presigning signs locally; the client only resolves credentials, so a short budget is plenty.
const S3_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 3_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };

export interface PresignedPost {
  /** Where the browser POSTs the form (the bucket endpoint). */
  readonly url: string;
  /** Form fields to send before the file, in order. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface PdfPresigner {
  /** Origin of `url`, the only storage origin the page's CSP lets the browser reach. */
  readonly origin: string;
  presign(key: string): Promise<PresignedPost>;
}

/** Conditions of every PDF upload besides the exact key and bucket, which the SDK adds. */
export function pdfPostConditions(): NonNullable<PresignedPostOptions["Conditions"]> {
  return [
    ["content-length-range", 1, MAX_DOCUMENT_BYTES],
    ["eq", "$Content-Type", PDF_CONTENT_TYPE],
  ];
}

/** `https://<bucket>.s3.<region>.amazonaws.com`, the same origin the console's CSP names. */
export function bucketOrigin(bucket: string, region: string = STAGE_REGION): string {
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

export interface S3PdfPresignerOptions {
  readonly bucket: string;
  readonly region?: string;
  /** Test and local seam: a client with other credentials or an emulator endpoint. */
  readonly client?: S3Client;
  /** Origin the client posts to when it is not the regional endpoint (the local S3 emulator). */
  readonly origin?: string;
}

export function s3PdfPresigner(options: S3PdfPresignerOptions): PdfPresigner {
  const region = options.region ?? STAGE_REGION;
  const origin = options.origin ?? bucketOrigin(options.bucket, region);
  let client = options.client;
  return {
    origin,
    async presign(key) {
      client ??= new S3Client({ region, ...awsClientConfig(S3_TIMEOUTS) });
      const post = await createPresignedPost(client, {
        Bucket: options.bucket,
        Key: key,
        Conditions: pdfPostConditions(),
        Fields: { "Content-Type": PDF_CONTENT_TYPE },
        Expires: PRESIGN_TTL_SECONDS,
      });
      // The page's CSP names one storage origin: a URL elsewhere would be blocked in the browser.
      if (new URL(post.url).origin !== origin) throw new RangeError("the presigned POST does not target the declared storage origin");
      return { url: post.url, fields: { ...post.fields } };
    },
  };
}
