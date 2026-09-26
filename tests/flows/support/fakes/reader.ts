// The external document reader in process (docs/test-plan.md §2, "lector y plataforma mock en
// proceso"): the real reader-mock app over an in-memory catalog, reached by the BFF's real reader
// client through an in-process `fetch`, and downloading the source from the same object store the
// S3 fake writes (`Documents` of the world). Source URLs are pre-signed locally by the BFF's own
// signer with made-up credentials; no request leaves the process.
import { S3Client } from "@aws-sdk/client-s3";
import { createReaderClient, type ReaderClient } from "@legajo/bff/reader/client";
import { createSourceUrlSigner, type SourceUrlSigner } from "@legajo/bff/reader/source-url";
import { READER_SOURCE_REGION } from "@legajo/reader-contract";
import { createReaderApp, createMemoryCatalog, type MemoryCatalog, type ReaderEvent } from "@legajo/reader-mock";
import { inProcessReaderFetch, type RecordedRequest } from "@legajo/reader-mock/testing";
import type { ObjectStore } from "./objects";

/** Name the local world gives its `Documents` bucket. */
export const LOCAL_DOCUMENTS_BUCKET = "legajo-local-documents";

export const LOCAL_READER_ENDPOINT = "https://reader.local-flows.test";

export interface InProcessReader {
  readonly catalog: MemoryCatalog;
  readonly client: ReaderClient;
  /** Pre-signed GET of a `Documents` key, as the intake builds it. */
  readonly sourceUrl: SourceUrlSigner;
  readonly documentsBucket: string;
  /** Every request the client sent, in order. */
  readonly requests: RecordedRequest[];
  readonly events: ReaderEvent[];
}

export interface InProcessReaderOptions {
  readonly objects: ObjectStore;
  readonly now: () => Date;
  readonly documentsBucket?: string;
}

export function inProcessReader(options: InProcessReaderOptions): InProcessReader {
  const documentsBucket = options.documentsBucket ?? LOCAL_DOCUMENTS_BUCKET;
  const catalog = createMemoryCatalog();
  const events: ReaderEvent[] = [];
  const requests: RecordedRequest[] = [];
  const app = createReaderApp({
    catalog,
    documentsBucket,
    now: options.now,
    sleep: () => Promise.resolve(),
    random: () => 0,
    onEvent: (event) => events.push(event),
    fetchSource: (url) => {
      const object = options.objects.get(documentsBucket, decodeURIComponent(url.pathname.slice(1)));
      const response = object === undefined ? new Response("AccessDenied", { status: 403 }) : new Response(object.body.slice(), { status: 200, headers: { "content-length": String(object.body.byteLength) } });
      return Promise.resolve(response);
    },
  });
  const signerClient = new S3Client({ region: READER_SOURCE_REGION, credentials: { accessKeyId: "local-flows-key-id", secretAccessKey: "local-flows-not-a-secret" } });
  return {
    catalog,
    documentsBucket,
    requests,
    events,
    sourceUrl: createSourceUrlSigner({ bucket: documentsBucket, s3: signerClient }),
    client: createReaderClient({
      endpoint: LOCAL_READER_ENDPOINT,
      // The Function URL of the stage checks SigV4; in process the headers go through unsigned.
      sign: (request) => Promise.resolve({ ...request.headers }),
      fetch: inProcessReaderFetch(app, requests),
      sleep: () => Promise.resolve(),
      random: () => 0,
      nowMs: () => options.now().getTime(),
    }),
  };
}
