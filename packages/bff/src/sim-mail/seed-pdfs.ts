// The synthetic PDFs the simulator attaches (docs/architecture.md §6, docs/seed-spec.md §8): the
// versions of each document of a model operation, `Seed/pdfs/<templateOperation>/<docType>-v<n>.pdf`,
// and the PDFs the reader does not know, `Seed/pdfs/unknown/<n>.pdf`. The bucket's name comes from its
// link (`Resource.Seed`); every call has the SDK's timeout and retries. Versions are listed once per
// container: the seed only changes with a deploy of `seed:load`.
import { GetObjectCommand, ListObjectsV2Command, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { DocType, ToolError, seedKeys } from "@legajo/shared";
import { SES_REGION } from "../channels/email/config";
import { awsClientConfig } from "../lib/clients";
import { bucketName } from "../lib/resource";
import { SEED_TIMEOUTS, UNKNOWN_PDF_COUNT } from "./config";

export interface SeedPdfStore {
  /** Highest version of a document of a model operation (its final version); NOT_FOUND when there is none. */
  latestVersion(templateOperation: string, docType: DocType): Promise<number>;
  read(templateOperation: string, docType: DocType, version: number): Promise<Uint8Array>;
  /** How many unknown PDFs the seed holds. */
  readonly unknownCount: number;
  readUnknown(index: number): Promise<Uint8Array>;
}

/** `pdfs/<op>/<DocType>-v<n>.pdf` → `n`. */
export function versionOfKey(key: string, templateOperation: string, docType: DocType): number | undefined {
  const prefix = seedKeys.pdf(templateOperation, docType, 1).replace(/1\.pdf$/, "");
  if (!key.startsWith(prefix)) return undefined;
  const match = /^(\d{1,3})\.pdf$/.exec(key.slice(prefix.length));
  return match ? Number(match[1]) : undefined;
}

export interface S3SeedPdfOptions {
  readonly client?: S3Client;
  readonly bucket?: () => string;
}

export function s3SeedPdfStore(options: S3SeedPdfOptions = {}): SeedPdfStore {
  let client = options.client;
  const s3 = (): S3Client => (client ??= new S3Client({ region: SES_REGION, ...awsClientConfig(SEED_TIMEOUTS) }));
  const bucket = options.bucket ?? (() => bucketName("Seed"));
  const latest = new Map<string, number>();

  async function getBytes(key: string, what: string): Promise<Uint8Array> {
    try {
      const object = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      const bytes = await object.Body?.transformToByteArray();
      if (bytes === undefined) throw new ToolError("NOT_FOUND", `${what} has no body`);
      return bytes;
    } catch (error) {
      if (error instanceof NoSuchKey) throw new ToolError("NOT_FOUND", `${what} is not in the seed`, undefined, { cause: error });
      if (error instanceof ToolError) throw error;
      throw new ToolError("UNAVAILABLE", `could not read ${what}`, undefined, { cause: error });
    }
  }

  return {
    async latestVersion(templateOperation, docType) {
      const cacheKey = `${templateOperation}#${DocType.parse(docType)}`;
      const cached = latest.get(cacheKey);
      if (cached !== undefined) return cached;
      const prefix = seedKeys.pdf(templateOperation, docType, 1).replace(/1\.pdf$/, "");
      let listed;
      try {
        listed = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, MaxKeys: 50 }));
      } catch (error) {
        throw new ToolError("UNAVAILABLE", `could not list the seed versions of ${docType} of ${templateOperation}`, undefined, { cause: error });
      }
      const versions = (listed.Contents ?? []).flatMap((object) => {
        const version = object.Key === undefined ? undefined : versionOfKey(object.Key, templateOperation, docType);
        return version === undefined ? [] : [version];
      });
      if (versions.length === 0) throw new ToolError("NOT_FOUND", `the seed has no ${docType} of ${templateOperation}`);
      const highest = Math.max(...versions);
      latest.set(cacheKey, highest);
      return highest;
    },

    read: (templateOperation, docType, version) => getBytes(seedKeys.pdf(templateOperation, docType, version), `${docType} v${version} of ${templateOperation}`),

    unknownCount: UNKNOWN_PDF_COUNT,

    readUnknown: (index) => getBytes(seedKeys.unknownPdf(index), `unknown PDF ${index}`),
  };
}
