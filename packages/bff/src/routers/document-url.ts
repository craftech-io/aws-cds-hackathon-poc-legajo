// Download link of a document version for the console (docs/architecture.md §10): a pre-signed GET
// of 5 minutes on `Documents`, issued only after the firm fence checked the version's operation,
// that forces `application/pdf` and a download (`attachment`), so a PDF never renders inline in the
// console's origin.
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import { PDF_CONTENT_TYPE, STAGE_REGION } from "../public-web/presign";

/** Lifetime of a download link, in seconds. */
export const DOCUMENT_URL_TTL_SECONDS = 5 * 60;

export interface DocumentUrlSigner {
  /** A GET link for `key` in `Documents`, valid for `DOCUMENT_URL_TTL_SECONDS`. */
  sign(key: string, filename: string): Promise<string>;
}

// Presigning signs locally; the client only resolves credentials.
const S3_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 3_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };

/** `4471-PL-v2.pdf`: built from ids, never from the name the file came with. */
export function downloadFilename(operationNumber: string, docShort: string, versionNo: number): string {
  return `${operationNumber}-${docShort}-v${versionNo}.pdf`;
}

export function s3DocumentUrlSigner(options: { readonly bucket: () => string; readonly client?: S3Client }): DocumentUrlSigner {
  let client = options.client;
  return {
    async sign(key, filename) {
      client ??= new S3Client({ region: STAGE_REGION, ...awsClientConfig(S3_TIMEOUTS) });
      const command = new GetObjectCommand({
        Bucket: options.bucket(),
        Key: key,
        ResponseContentType: PDF_CONTENT_TYPE,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      });
      return getSignedUrl(client, command, { expiresIn: DOCUMENT_URL_TTL_SECONDS });
    },
  };
}
