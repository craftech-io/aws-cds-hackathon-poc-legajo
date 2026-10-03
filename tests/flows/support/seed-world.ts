// The seed of the local flows: the real `seed:load` (scripts/seed/load/run.ts) over the in-memory
// stores, with the world factory's dependencies of a local world (the flows' master key, the S3 and
// Scheduler fakes behind the factory's ports, Memory in maps). It writes the static rows (firms,
// brokers, `Reference`, the reader's catalog) and builds the demo worlds (`GLOBAL#firm-delta`, `GLOBAL#firm-norte`, `GLOBAL#firm-qa`) from their templates, exactly
// as the stage's seed job does; the `Seed` bucket stays in a map that SimMail and the guest worlds read.
//
// The seed's brokers carry no Cognito `sub` until someone signs in; the flows bind each broker to the
// `sub` of its test principal (routers/testing.ts), as the first sign-in of the stage would.
import { brokerKey } from "@legajo/bff/connector/keys";
import type { MemoryStores } from "@legajo/bff/connector/index";
import type { SecretKey } from "@legajo/bff/lib/crypto";
import type { Logger } from "@legajo/bff/lib/log";
import { SeedOverrides } from "@legajo/bff/lib/secrets";
import type { SeedPdfStore } from "@legajo/bff/sim-mail/seed-pdfs";
import { versionOfKey } from "@legajo/bff/sim-mail/seed-pdfs";
import { SUBS } from "@legajo/bff/routers/testing";
import { factoryKeysOf, type WorldsDeps } from "@legajo/bff/worlds/deps";
import { purgeRemainingPasses } from "@legajo/bff/worlds/memory-purge";
import { memoryWorldObjects } from "@legajo/bff/worlds/objects";
import { staticTemplateSource } from "@legajo/bff/worlds/template";
import { MapMemory, MAIL_PREFIXES } from "@legajo/bff/worlds/testing";
import type { SchedulerPort } from "@legajo/bff/timers/scheduler-client";
import { type DocType, seedKeys } from "@legajo/shared";
import { readSeed, type SeedOnDisk } from "../../../scripts/seed/lib/files";
import { parseLoadArgs } from "../../../scripts/seed/load/plan";
import { runLoad } from "../../../scripts/seed/load/run";

let cached: SeedOnDisk | undefined;

/** The seed on disk, read once per test process. */
export function seedOnDisk(): SeedOnDisk {
  cached ??= readSeed();
  return cached;
}

/** The `Seed` bucket as a map, keyed like the stage's (`pdfs/…`, `worlds/…`, the reader's catalog). */
export type SeedBucketObjects = Map<string, Uint8Array>;

export interface WorldsOptions {
  readonly stores: MemoryStores;
  readonly master: SecretKey;
  readonly scheduler: SchedulerPort;
  readonly now: () => Date;
  readonly log: Logger;
}

/** The world factory's dependencies of a local world: Memory purges run every pass in process. */
export function localWorldsDeps(options: WorldsOptions): WorldsDeps {
  const memory = new MapMemory();
  const deps: WorldsDeps = {
    client: options.stores.client,
    data: options.stores.connector,
    seed: options.stores.seed,
    templates: staticTemplateSource(seedOnDisk().templates),
    keys: factoryKeysOf(options.master),
    scheduler: options.scheduler,
    objects: memoryWorldObjects(),
    memory,
    continuePurge: async (target) => {
      await purgeRemainingPasses({ memory, data: options.stores.connector, log: options.log, now: options.now, sleep: async () => undefined }, target);
    },
    mailPrefixes: () => MAIL_PREFIXES,
    now: options.now,
    log: options.log,
  };
  return deps;
}

/** The test principals of routers/testing.ts, bound to the seed's brokers. */
const BROKER_SUBS: ReadonlyArray<readonly [firmId: string, brokerId: string, sub: string]> = [
  ["firm-delta", "brk-delta-diego", SUBS.diego],
  ["firm-delta", "brk-delta-martina", SUBS.martina],
];

/** `seed:load` over memory (every demo world and the static rows); returns the `Seed` bucket it filled. */
export async function loadDemoSeed(worlds: WorldsDeps): Promise<SeedBucketObjects> {
  const objects: SeedBucketObjects = new Map();
  await runLoad(seedOnDisk(), parseLoadArgs([]), {
    bucket: {
      put: async (key, body) => void objects.set(key, body),
      getText: async (key) => (objects.has(key) ? new TextDecoder().decode(objects.get(key)) : undefined),
    },
    worlds,
    overrides: SeedOverrides.parse({}),
    report: () => undefined,
  });
  for (const [firmId, brokerId, sub] of BROKER_SUBS) {
    const key = brokerKey(firmId, brokerId);
    const row = await worlds.client.get("Firms", key);
    if (row !== undefined) await worlds.client.put("Firms", { ...row, cognitoSub: sub, cognitoSubKey: `SUB#${sub}` });
  }
  return objects;
}

/** SimMail's view of the `Seed` bucket (sim-mail/seed-pdfs.ts) over the map. */
export function mapSeedPdfStore(objects: SeedBucketObjects): SeedPdfStore {
  const unknown = [...objects.keys()].filter((key) => key.startsWith(seedKeys.unknownPdf(1).replace(/1\.pdf$/, "")));
  const bytesOf = (key: string): Uint8Array => {
    const bytes = objects.get(key);
    if (bytes === undefined) throw new Error(`${key} is not in the local Seed bucket`);
    return bytes;
  };
  return {
    async latestVersion(templateOperation: string, docType: DocType) {
      const versions = [...objects.keys()].flatMap((key) => {
        const version = versionOfKey(key, templateOperation, docType);
        return version === undefined ? [] : [version];
      });
      if (versions.length === 0) throw new Error(`no ${docType} of ${templateOperation} in the local Seed bucket`);
      return Math.max(...versions);
    },
    read: async (templateOperation, docType, version) => bytesOf(seedKeys.pdf(templateOperation, docType, version)),
    unknownCount: unknown.length,
    readUnknown: async (index) => bytesOf(seedKeys.unknownPdf(index)),
  };
}
