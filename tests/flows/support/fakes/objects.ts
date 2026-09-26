// In-process S3 of the local flows: the buckets the stage's code reads and writes through
// `@aws-sdk/client-s3` (mail, documents, media, uploads, quarantine prefixes), kept in a map. The
// reader mock downloads from the same map (fakes/reader.ts), so a document the intake copies to
// `Documents` is the one the reader reads.
import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";

export interface StoredObject {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ObjectStore {
  put(object: { readonly bucket: string; readonly key: string; readonly body: Uint8Array | string; readonly contentType?: string; readonly metadata?: Record<string, string> }): StoredObject;
  get(bucket: string, key: string): StoredObject | undefined;
  delete(bucket: string, key: string): boolean;
  keys(bucket: string, prefix?: string): string[];
}

export function createObjectStore(): ObjectStore {
  const objects = new Map<string, StoredObject>();
  const id = (bucket: string, key: string) => `${bucket}/${key}`;
  return {
    put(object) {
      const body = typeof object.body === "string" ? new TextEncoder().encode(object.body) : object.body.slice();
      const stored: StoredObject = {
        bucket: object.bucket,
        key: object.key,
        body,
        ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
        metadata: { ...object.metadata },
      };
      objects.set(id(object.bucket, object.key), stored);
      return stored;
    },
    get: (bucket, key) => objects.get(id(bucket, key)),
    delete: (bucket, key) => objects.delete(id(bucket, key)),
    keys: (bucket, prefix = "") =>
      [...objects.values()]
        .filter((object) => object.bucket === bucket && object.key.startsWith(prefix))
        .map((object) => object.key)
        .sort(),
  };
}

/** Bytes of a `PutObject` body in the shapes the SDK accepts from our code. */
export async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body !== null && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    return new Uint8Array(Buffer.concat(chunks));
  }
  throw new TypeError("unsupported PutObject body in the local flows");
}

/** A `GetObject` body with the SDK's stream helpers our code calls. */
export function objectBody(bytes: Uint8Array): NonNullable<GetObjectCommandOutput["Body"]> {
  const body = {
    transformToByteArray: () => Promise.resolve(bytes.slice()),
    transformToString: (encoding = "utf-8") => Promise.resolve(new TextDecoder(encoding).decode(bytes)),
    transformToWebStream: () => new Blob([bytes.slice()]).stream(),
  };
  return body as unknown as NonNullable<GetObjectCommandOutput["Body"]>;
}

/** `bucket/key` of a `CopySource` (URL-encoded key, optional leading slash). */
export function parseCopySource(source: string): { readonly bucket: string; readonly key: string } {
  const [bucket = "", ...rest] = source.replace(/^\//, "").split("/");
  return { bucket, key: decodeURIComponent(rest.join("/").split("?")[0] ?? "") };
}
