// The S3 objects of a world that `destroyWorld` and the reset of a reserved guest world delete
// (ADR-0015 §4, docs/architecture.md §6 and §8):
//
//   Documents, Media   the world's prefix `guest/<pub|res>/<firmId>/e<epoch>/` (or `qa/<runId>/` of a QA run)
//   Uploads            `uploads/<token>/` of every upload link the world's messages carried
//   InboundMail        the raw MIME its messages cite (`<stage>/ops/<sesMessageId>`, `<stage>/sim/<id>`)
//
// The bucket names and the prefixes the role may delete under come from its link: `GuestObjects`
// (WorldJanitor, Bff: infra/leads.ts, `s3:DeleteObject` and `s3:ListBucket` under those prefixes only) or
// `QaWorldObjects` (QaDriver: `qa/` and the guest-test world's prefix, never `uploads/` nor the mail
// bucket). A key outside them is refused here before S3 would refuse it; `destroyWorld` asks `covers`
// first and leaves what the role may not delete to the bucket's lifecycle. Every call has a deadline and
// the SDK's retries.
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { awsClientConfig, type ClientTimeouts } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { STAGE_REGION } from "../public-web/presign";

export type WorldObjectBucket = "Documents" | "Media" | "Uploads" | "InboundMail";

export interface WorldObjects {
  /** Whether the role may delete `prefixOrKey` of `bucket` (under one of its granted prefixes). */
  covers(bucket: WorldObjectBucket, prefixOrKey: string): boolean;
  /** Deletes every object under `prefix`; how many it deleted. */
  deletePrefix(bucket: WorldObjectBucket, prefix: string): Promise<number>;
  /** Deletes these keys (a key already gone is fine); how many it asked to delete. */
  deleteKeys(bucket: WorldObjectBucket, keys: readonly string[]): Promise<number>;
}

const GuestObjectsLink = z.object({
  documentsBucket: z.string().min(1),
  mediaBucket: z.string().min(1),
  uploadsBucket: z.string().min(1),
  inboundMailBucket: z.string().min(1),
  prefixes: z.object({ Documents: z.array(z.string()), Media: z.array(z.string()), Uploads: z.array(z.string()), InboundMail: z.array(z.string()) }),
});
type GuestObjectsLink = z.infer<typeof GuestObjectsLink>;

/** What a role's link gives `s3WorldObjects`: a bucket name and the prefixes it may delete under, per bucket. */
export interface WorldObjectsGrant {
  readonly buckets: Readonly<Partial<Record<WorldObjectBucket, string>>>;
  readonly prefixes: Readonly<Partial<Record<WorldObjectBucket, readonly string[]>>>;
}

const QaWorldObjectsLink = z.object({
  documentsBucket: z.string().min(1),
  mediaBucket: z.string().min(1),
  uploadsBucket: z.string().min(1),
  prefixes: z.object({ Documents: z.array(z.string()), Media: z.array(z.string()), Uploads: z.array(z.string()) }),
});

/** `GuestObjects` (WorldJanitor, Bff): the four buckets of a guest world. */
export function guestObjectsGrant(): WorldObjectsGrant {
  const link = readLinked("GuestObjects", GuestObjectsLink);
  return {
    buckets: { Documents: link.documentsBucket, Media: link.mediaBucket, Uploads: link.uploadsBucket, InboundMail: link.inboundMailBucket },
    prefixes: link.prefixes,
  };
}

/** `QaWorldObjects` (QaDriver): Documents, Media and Uploads under its prefixes; no mail bucket at all. */
export function qaWorldObjectsGrant(): WorldObjectsGrant {
  const link = readLinked("QaWorldObjects", QaWorldObjectsLink);
  return { buckets: { Documents: link.documentsBucket, Media: link.mediaBucket, Uploads: link.uploadsBucket }, prefixes: link.prefixes };
}

/** The raw MIME prefixes of the mail bucket (`poc/ops/`, `poc/sim/`). */
export function inboundMailPrefixes(): readonly string[] {
  return readLinked("GuestObjects", GuestObjectsLink).prefixes.InboundMail;
}

/** A key the role may delete: under one of the bucket's granted prefixes, no `..`, never the prefix alone. */
export function isDeletable(key: string, prefixes: readonly string[]): boolean {
  return !key.includes("..") && prefixes.some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
}

// A destroy lists and deletes a few hundred objects at most: short calls, a few attempts.
const OBJECT_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 4 };
/** DeleteObjects takes at most 1,000 keys per call. */
const DELETE_BATCH = 1_000;

export interface S3WorldObjectsOptions {
  readonly client?: S3Client;
  /** The role's grant; `GuestObjects` when omitted. */
  readonly grant?: () => WorldObjectsGrant;
}

export function s3WorldObjects(options: S3WorldObjectsOptions = {}): WorldObjects {
  let client = options.client;
  const s3 = (): S3Client => (client ??= new S3Client({ region: STAGE_REGION, ...awsClientConfig(OBJECT_TIMEOUTS) }));
  const grant = options.grant ?? guestObjectsGrant;
  const grantedPrefixes = (bucket: WorldObjectBucket): readonly string[] => (grant().buckets[bucket] === undefined ? [] : (grant().prefixes[bucket] ?? []));
  const bucketOf = (bucket: WorldObjectBucket): string => {
    const name = grant().buckets[bucket];
    if (name === undefined) throw new RangeError(`no ${bucket} bucket in this role's grant`);
    return name;
  };

  async function remove(bucket: WorldObjectBucket, keys: readonly string[]): Promise<number> {
    const granted = grantedPrefixes(bucket);
    const deletable = [...new Set(keys)].filter((key) => isDeletable(key, granted));
    if (deletable.length !== new Set(keys).size) throw new RangeError(`refused to delete ${new Set(keys).size - deletable.length} key(s) outside the ${bucket} prefixes of a world`);
    for (let start = 0; start < deletable.length; start += DELETE_BATCH) {
      const batch = deletable.slice(start, start + DELETE_BATCH);
      const answer = await s3().send(new DeleteObjectsCommand({ Bucket: bucketOf(bucket), Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
      const failed = (answer.Errors ?? []).filter((error) => error.Code !== "NoSuchKey");
      if (failed.length > 0) throw new Error(`${failed.length} object(s) of ${bucket} could not be deleted`);
    }
    return deletable.length;
  }

  return {
    covers: (bucket, prefixOrKey) => isDeletable(prefixOrKey, grantedPrefixes(bucket)),

    async deletePrefix(bucket, prefix) {
      if (!isDeletable(prefix, grantedPrefixes(bucket))) throw new RangeError(`refused to delete outside the ${bucket} prefixes of a world`);
      let deleted = 0;
      let token: string | undefined;
      do {
        const page = await s3().send(new ListObjectsV2Command({ Bucket: bucketOf(bucket), Prefix: prefix, ContinuationToken: token }));
        const keys = (page.Contents ?? []).flatMap((object) => (object.Key === undefined ? [] : [object.Key]));
        if (keys.length > 0) deleted += await remove(bucket, keys);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return deleted;
    },

    deleteKeys: (bucket, keys) => remove(bucket, keys),
  };
}

/** Objects in memory, for the tests and the local flows: `objects.get(bucket)` holds the keys. */
export interface MemoryWorldObjects extends WorldObjects {
  readonly objects: Map<WorldObjectBucket, Set<string>>;
  put(bucket: WorldObjectBucket, key: string): void;
}

/** `granted`: the prefixes per bucket the role may delete under; every key when omitted. */
export function memoryWorldObjects(granted?: Partial<Record<WorldObjectBucket, readonly string[]>>): MemoryWorldObjects {
  const objects = new Map<WorldObjectBucket, Set<string>>();
  const of = (bucket: WorldObjectBucket): Set<string> => {
    let keys = objects.get(bucket);
    if (keys === undefined) objects.set(bucket, (keys = new Set()));
    return keys;
  };
  return {
    objects,
    put: (bucket, key) => void of(bucket).add(key),
    covers: (bucket, prefixOrKey) => granted === undefined || isDeletable(prefixOrKey, granted[bucket] ?? []),
    async deletePrefix(bucket, prefix) {
      if (granted !== undefined && !isDeletable(prefix, granted[bucket] ?? [])) throw new RangeError(`refused to delete outside the ${bucket} prefixes of a world`);
      let deleted = 0;
      for (const key of of(bucket)) if (key.startsWith(prefix) && of(bucket).delete(key)) deleted += 1;
      return deleted;
    },
    async deleteKeys(bucket, keys) {
      if (granted !== undefined && keys.some((key) => !isDeletable(key, granted[bucket] ?? []))) throw new RangeError(`refused to delete keys outside the ${bucket} prefixes of a world`);
      for (const key of keys) of(bucket).delete(key);
      return keys.length;
    },
  };
}
