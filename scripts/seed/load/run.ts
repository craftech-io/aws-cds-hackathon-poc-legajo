// The run of `seed:load` (docs/seed-spec.md §3 and §16) over ports, so the test drives it in memory:
//
//   1 same fingerprint as the last load and no `--force`: nothing happens
//   2 the `Seed` bucket: PDFs, the reader's catalog, the batch inputs and the world templates
//   3 the static rows (validated by the seed store; a broker row keeps the Cognito `sub` it was bound
//     to) and the reader's catalog in `ReaderCatalog`
//   4 every demo world through the world factory: created at epoch 1 when its clock does not exist,
//     otherwise reset ("Reiniciar demo" as `seed:load`: the epoch goes up, never back to 1, the old
//     epoch is tombstoned, its Memory purged in every pass in this process, the world rewritten with new
//     thread tags, actors and sessions); the operator's phone overrides apply to the demo importers
//   5 `AuditLog ACTION SEED_LOADED` with the fingerprint, and the fingerprint recorded last
//
// Guest worlds are never touched: they take the new template on their next reset or creation.
import { resetWorld } from "@legajo/bff/clock/reset";
import { brokerKey } from "@legajo/bff/connector/keys";
import type { SeedOverrides } from "@legajo/bff/lib/secrets";
import { createWorld } from "@legajo/bff/worlds/factory";
import { DEMO_FIRMS } from "@legajo/bff/worlds/plan";
import type { WorldsDeps } from "@legajo/bff/worlds/deps";
import { resetDepsOf } from "@legajo/bff/worlds/rebuild";
import type { SeedOnDisk } from "../lib/files";
import type { SeedItem } from "../lib/items";
import { LOADED_KEY, type LoadArgs, demoTemplatesFor, fingerprintOf, seedObjects, staticRows } from "./plan";

/** The `Seed` bucket as the loader sees it. */
export interface SeedBucket {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** The object's text, or `undefined` when it does not exist. */
  getText(key: string): Promise<string | undefined>;
}

export interface LoadPorts {
  readonly bucket: SeedBucket;
  /** The world factory over the stage's tables, keys, Scheduler and Memory; every purge pass in process. */
  readonly worlds: WorldsDeps;
  readonly overrides: SeedOverrides;
  readonly report: (line: string) => void;
}

export interface WorldLoaded {
  readonly clockId: string;
  readonly worldEpoch: number;
  readonly action: "CREATED" | "RESET";
}

export interface LoadResult {
  readonly skipped: boolean;
  readonly fingerprint: string;
  readonly worlds: readonly WorldLoaded[];
}

type KeyedItem = SeedItem & { readonly PK: string; readonly SK: string };

/** Rows of the table files carry their keys (docs/seed-spec.md §1); one without them is a broken seed. */
function keyed(items: readonly SeedItem[]): KeyedItem[] {
  return items.map((item) => {
    if (typeof item.PK !== "string" || typeof item.SK !== "string") throw new Error(`a ${item.entity} row of the seed has no key`);
    return item as KeyedItem;
  });
}

/** A broker row that exists keeps its `sub` (and its index attribute) across reloads. */
async function keepBrokerBindings(items: readonly KeyedItem[], worlds: WorldsDeps): Promise<KeyedItem[]> {
  const out: KeyedItem[] = [];
  for (const item of items) {
    if (item.entity !== "Broker") {
      out.push(item);
      continue;
    }
    const stored = await worlds.client.get("Firms", brokerKey(String(item.firmId), String(item.brokerId)));
    const sub = typeof stored?.cognitoSub === "string" ? stored.cognitoSub : "";
    out.push(sub === "" ? item : { ...item, cognitoSub: sub, cognitoSubKey: `SUB#${sub}` });
  }
  return out;
}

export async function runLoad(seed: SeedOnDisk, args: LoadArgs, ports: LoadPorts): Promise<LoadResult> {
  const fingerprint = fingerprintOf(seed, ports.overrides);
  const previous = await ports.bucket.getText(LOADED_KEY);
  const loadedBefore = previous === undefined ? undefined : (JSON.parse(previous) as { fingerprint?: string }).fingerprint;
  if (loadedBefore === fingerprint && !args.force) {
    ports.report("same fingerprint as the last load: nothing to do (use --force to reload)");
    return { skipped: true, fingerprint, worlds: [] };
  }

  for (const object of seedObjects(seed)) await ports.bucket.put(object.key, object.body, object.contentType);
  ports.report("seed bucket written (PDFs, reader catalog, batch inputs, world templates)");

  const { worlds } = ports;
  const rows = staticRows(seed, args.firm);
  if (rows.Firms.length > 0) await worlds.seed.loadItems("Firms", await keepBrokerBindings(keyed(rows.Firms), worlds));
  if (rows.Reference.length > 0) await worlds.seed.loadItems("Reference", keyed(rows.Reference));
  if (rows.ReaderCatalog.length > 0) await worlds.client.batchPut("ReaderCatalog", keyed(rows.ReaderCatalog));

  const importerPhones = ports.overrides.importerPhones;
  const loaded: WorldLoaded[] = [];
  for (const template of demoTemplatesFor(args.firm)) {
    const clockId = `GLOBAL#${DEMO_FIRMS[template]}`;
    if ((await worlds.data.world.findClock(clockId)) === undefined) {
      const created = await createWorld({ kind: "DEMO", template, importerPhones }, worlds);
      loaded.push({ clockId, worldEpoch: created.worldEpoch, action: "CREATED" });
    } else {
      const reset = await resetWorld({ clockId, caller: "SEED", actor: "SYSTEM" }, resetDepsOf(worlds, { importerPhones }));
      loaded.push({ clockId, worldEpoch: reset.worldEpoch, action: "RESET" });
    }
    ports.report(`${clockId}: ${loaded.at(-1)?.action.toLowerCase() ?? ""} at epoch ${String(loaded.at(-1)?.worldEpoch)}`);
  }

  const atReal = worlds.now().toISOString();
  for (const firmId of new Set(loaded.map((world) => world.clockId.slice("GLOBAL#".length)))) {
    await worlds.data.audit.record({ firmId, decision: "ACTION", action: "SEED_LOADED", actor: "SYSTEM", atReal, detail: { fingerprint, force: args.force, worlds: loaded.length } });
  }
  await ports.bucket.put(LOADED_KEY, new TextEncoder().encode(JSON.stringify({ fingerprint, loadedAt: atReal })), "application/json");
  return { skipped: false, fingerprint, worlds: loaded };
}
