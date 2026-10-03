// Test harness of the world factory (never imported by runtime code): the connector over memory, the
// world templates of `scripts/seed/data/worlds/` as the factory would read them from `Seed`, a fixed
// master key, a recording Scheduler, S3 objects and AgentCore Memory in maps, and the Memory purges
// handed on after pass 1. Real time is settable.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorldTemplateName } from "@legajo/shared";
import { createMemoryStores, type MemoryStores } from "../connector/index";
import { createLogger, type Logger } from "../lib/log";
import type { ScheduleSpec, SchedulerPort } from "../timers/scheduler-client";
import { factoryKeysOf, type WorldsDeps } from "./deps";
import type { MemoryAdmin, PurgeTarget } from "./memory-purge";
import { type MemoryWorldObjects, memoryWorldObjects } from "./objects";
import { staticTemplateSource } from "./template";

export const WORLDS_MASTER_KEY = "worlds-test-master-key-0000000000";
export const WORLDS_REAL_NOW = "2026-10-14T13:30:00.000Z";
export const MAIL_PREFIXES = ["poc/ops/", "poc/sim/"] as const;

const TEMPLATES_DIR = fileURLToPath(new URL("../../../../scripts/seed/data/worlds/", import.meta.url));

/** Every world template of the seed, parsed from disk once per process. */
let templates: Partial<Record<WorldTemplateName, unknown>> | undefined;
export function seedTemplates(): Partial<Record<WorldTemplateName, unknown>> {
  templates ??= Object.fromEntries(WorldTemplateName.options.map((name) => [name, JSON.parse(readFileSync(`${TEMPLATES_DIR}${name}.json`, "utf8")) as unknown]));
  return templates;
}

/** Memory in maps: events per `<actor>/<session>`, records per namespace. */
export class MapMemory implements MemoryAdmin {
  readonly events = new Map<string, string[]>();
  readonly records = new Map<string, string[]>();

  async listSessionIds(actorId: string) {
    return [...this.events.keys()].filter((key) => key.startsWith(`${actorId}/`)).map((key) => key.slice(actorId.length + 1));
  }
  async listEventIds(actorId: string, sessionId: string) {
    return [...(this.events.get(`${actorId}/${sessionId}`) ?? [])];
  }
  async deleteEvent(actorId: string, sessionId: string, eventId: string) {
    const key = `${actorId}/${sessionId}`;
    this.events.set(key, (this.events.get(key) ?? []).filter((id) => id !== eventId));
  }
  async listRecordIds(prefix: string) {
    return [...this.records.entries()].filter(([namespace]) => namespace.startsWith(prefix)).flatMap(([, ids]) => ids);
  }
  async deleteRecord(recordId: string) {
    for (const [namespace, ids] of this.records) this.records.set(namespace, ids.filter((id) => id !== recordId));
  }
  /** Every event and record still stored. */
  remaining(): number {
    return [...this.events.values(), ...this.records.values()].flat().length;
  }
}

export interface RecordingScheduler extends SchedulerPort {
  readonly deletes: string[];
}

function recordingScheduler(): RecordingScheduler {
  const deletes: string[] = [];
  return { deletes, put: (_spec: ScheduleSpec) => Promise.resolve(), delete: async (name) => void deletes.push(name) };
}

export interface WorldsHarness {
  readonly stores: MemoryStores;
  readonly deps: WorldsDeps;
  readonly objects: MemoryWorldObjects;
  readonly memory: MapMemory;
  readonly scheduler: RecordingScheduler;
  /** Targets handed on after pass 1 (`WorldJanitor MEMORY_PURGE` in the stage). */
  readonly purges: PurgeTarget[];
  readonly lines: string[];
  realNow: Date;
}

export function worldsHarness(options: { readonly realNow?: string; readonly stores?: MemoryStores } = {}): WorldsHarness {
  const lines: string[] = [];
  const purges: PurgeTarget[] = [];
  const objects = memoryWorldObjects();
  const memory = new MapMemory();
  const scheduler = recordingScheduler();
  const harness = { realNow: new Date(options.realNow ?? WORLDS_REAL_NOW) } as { realNow: Date };
  const now = () => harness.realNow;
  const stores = options.stores ?? createMemoryStores({ now });
  const log: Logger = createLogger({ sink: (line) => void lines.push(line), now });
  const deps: WorldsDeps = {
    client: stores.client,
    data: stores.connector,
    seed: stores.seed,
    templates: staticTemplateSource(seedTemplates()),
    keys: factoryKeysOf(WORLDS_MASTER_KEY),
    scheduler,
    objects,
    memory,
    continuePurge: async (target) => void purges.push(target),
    mailPrefixes: () => MAIL_PREFIXES,
    now,
    log,
  };
  return Object.assign(harness, { stores, deps, objects, memory, scheduler, purges, lines });
}
