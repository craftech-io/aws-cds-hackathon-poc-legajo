// What the world factory needs (capability `WORLDS`, docs/architecture.md §14): the tables through the
// connector and its raw client, the seed store that validates every item, the templates of `Seed`, the
// stage's subkeys, the Scheduler (a world's schedules go with it), the world's S3 objects, AgentCore
// Memory, and who continues a Memory purge after its first pass. `WorldJanitor` and `seed:load` run
// every pass in process; the console and the `QaDriver` hand passes 2+ to `WorldJanitor`
// (`MEMORY_PURGE`, docs/architecture.md §9.3). Lambdas build the default set from their links
// (`Resource`, never `process.env`); tests pass memory stores and fakes.
import { type Connector, type SeedStore, type TableClient, connector, seedStore, tableClient } from "../connector/index";
import { type SecretKey, deriveSubkey } from "../lib/crypto";
import { type Logger } from "../lib/log";
import { subkey } from "../lib/secrets";
import { eventBridgeScheduler, type SchedulerPort } from "../timers/scheduler-client";
import type { WorldKeys } from "./instantiate";
import { agentCoreMemoryAdmin } from "./memory-admin";
import type { MemoryAdmin, PurgeTarget } from "./memory-purge";
import { inboundMailPrefixes, s3WorldObjects, type WorldObjects } from "./objects";
import { s3TemplateSource, type TemplateSource } from "./template";

export interface FactoryKeys extends WorldKeys {
  /** `runtime-session` subkey: the Harness sessions of a past epoch, for the Memory purge. */
  readonly runtimeSession: SecretKey;
}

export interface WorldsDeps {
  readonly client: TableClient;
  readonly data: Connector;
  readonly seed: SeedStore;
  readonly templates: TemplateSource;
  readonly keys: FactoryKeys;
  readonly scheduler: SchedulerPort;
  readonly objects: WorldObjects;
  readonly memory: MemoryAdmin;
  /** Passes 2+ of a Memory purge (`purgeRemainingPasses` in process, or `WorldJanitor MEMORY_PURGE`). */
  readonly continuePurge: (target: PurgeTarget) => Promise<void>;
  /** Raw MIME prefixes of the mail bucket (`poc/ops/`, `poc/sim/`) whose objects a guest world's messages cite. */
  readonly mailPrefixes: () => readonly string[];
  /** Real time. */
  readonly now: () => Date;
  readonly log: Logger;
}

/** The subkeys of `SessionTokenKey` the factory derives with (lib/secrets.ts). */
export function stageFactoryKeys(): FactoryKeys {
  return { thread: subkey("thread"), phoneHash: subkey("phone-hash"), emailHash: subkey("email-hash"), runtimeSession: subkey("runtime-session") };
}

/** The same subkeys of an explicit master key (tests, the local flows). */
export function factoryKeysOf(master: SecretKey): FactoryKeys {
  return { thread: deriveSubkey(master, "thread"), phoneHash: deriveSubkey(master, "phone-hash"), emailHash: deriveSubkey(master, "email-hash"), runtimeSession: deriveSubkey(master, "runtime-session") };
}

/** The Lambda's set (one per container); `continuePurge` says who runs passes 2+. */
export function stageWorldsDeps(options: { readonly log: Logger; readonly continuePurge: WorldsDeps["continuePurge"] }): WorldsDeps {
  return {
    client: tableClient(),
    data: connector(),
    seed: seedStore(),
    templates: s3TemplateSource(),
    keys: stageFactoryKeys(),
    scheduler: eventBridgeScheduler(),
    objects: s3WorldObjects(),
    memory: agentCoreMemoryAdmin(),
    continuePurge: options.continuePurge,
    mailPrefixes: inboundMailPrefixes,
    now: () => new Date(),
    log: options.log,
  };
}
