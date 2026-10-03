// The stage side of `seed:load`: the `Seed` bucket over S3 and the world factory over the stage's
// tables, subkeys, Scheduler, S3 objects and AgentCore Memory, all from the resources `sst shell`
// links (`Resource`, never `process.env`), and the overrides from `scripts/seed/overrides.local.json`
// when it exists, else from the `SeedOverrides` secret. Every Memory purge runs all its passes here.
import { existsSync, readFileSync } from "node:fs";
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { connector } from "@legajo/bff/connector/index";
import { awsClientConfig } from "@legajo/bff/lib/clients";
import { createLogger } from "@legajo/bff/lib/log";
import { bucketName } from "@legajo/bff/lib/resource";
import { type SeedOverrides, parseSeedOverrides, seedOverrides } from "@legajo/bff/lib/secrets";
import { STAGE_REGION } from "@legajo/bff/public-web/presign";
import { stageWorldsDeps, type WorldsDeps } from "@legajo/bff/worlds/deps";
import { agentCoreMemoryAdmin } from "@legajo/bff/worlds/memory-admin";
import { purgeRemainingPasses } from "@legajo/bff/worlds/memory-purge";
import { staticTemplateSource } from "@legajo/bff/worlds/template";
import type { SeedOnDisk } from "../lib/files";
import type { SeedBucket } from "./run";

const S3_TIMEOUTS = { requestTimeoutMs: 15_000, connectionTimeoutMs: 2_000, maxAttempts: 4 };

export function s3SeedBucket(client = new S3Client({ region: STAGE_REGION, ...awsClientConfig(S3_TIMEOUTS) })): SeedBucket {
  const Bucket = bucketName("Seed");
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async getText(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return await object.Body?.transformToString("utf8");
      } catch (error) {
        if (error instanceof NoSuchKey) return undefined;
        throw error;
      }
    },
  };
}

/** The local overrides file wins over the stage's secret (docs/seed-spec.md §1). */
export function loadOverrides(localPath: string): SeedOverrides {
  return existsSync(localPath) ? parseSeedOverrides(readFileSync(localPath, "utf8")) : seedOverrides();
}

/** The world factory of the stage; the templates are the ones on disk (the same bytes the bucket gets). */
export function stageLoaderWorlds(seed: SeedOnDisk): WorldsDeps {
  const log = createLogger({ bindings: { service: "seed-load" } });
  const purge = { memory: agentCoreMemoryAdmin(), data: connector(), log, now: () => new Date(), sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
  const raw = Object.fromEntries([...seed.dataFiles].filter(([path]) => path.startsWith("worlds/")).map(([path, bytes]) => [path.slice("worlds/".length, -".json".length), JSON.parse(bytes.toString("utf8")) as unknown]));
  return {
    ...stageWorldsDeps({
      log,
      continuePurge: async (target) => {
        await purgeRemainingPasses(purge, target);
      },
    }),
    templates: staticTemplateSource(raw),
  };
}
