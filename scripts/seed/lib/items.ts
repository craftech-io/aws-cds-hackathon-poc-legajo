// Seeded items in their two forms. A *template* item is an entity of the domain without the fields a
// world derives from the stage's key or its epoch (thread tag and address, phone and email hashes,
// the epoch itself) and without keys: that is what `data/worlds/*.json` holds and what the world
// factory completes (docs/seed-spec.md §1). An *instance* item is the same entity completed for one
// world and epoch (the seed's test key here, the stage's subkeys in `seed:load`), placed at the key and
// with the GSI attributes the connector gives it (packages/bff/src/connector/item-shape.ts): what the
// table files of `data/` hold. The generator builds template items and instantiates the demo worlds
// from them, so both forms come from one structure.
import { expectedIndexAttributes, expectedKey } from "@legajo/bff/connector/item-shape";
import { worldOfClock, type EntityName } from "@legajo/bff/domain/common";
import { SEED_REAL_NOW } from "./constants";
import { seedEmailHash, seedPhoneHash, seedThread } from "./seed-keys";

export type SeedItem = Record<string, unknown> & { readonly entity: string };

/** Stands for the operation's thread address in a message of a template (`from`/`to` of an email). */
export const THREAD_ADDRESS_PLACEHOLDER = "{threadAddress}";

/** Fields each entity derives from the stage's key or the world's epoch. */
export const DERIVED_FIELDS: Readonly<Partial<Record<EntityName, readonly string[]>>> = {
  Operation: ["worldEpoch", "threadTag", "threadAddress"],
  Importer: ["phoneHash"],
  SupplierContact: ["emailHash"],
};

/** The metadata of every seeded item (docs/seed-spec.md §1). */
export function seedStamp(clockId?: string): Record<string, unknown> {
  const world = clockId === undefined ? undefined : worldOfClock(clockId);
  return { createdAt: SEED_REAL_NOW, updatedAt: SEED_REAL_NOW, version: 1, synthetic: true, ...(world === undefined ? {} : { world }) };
}

/** A template item: the entity's fields plus the seed's stamp. */
export function templateItem(entity: EntityName, fields: Readonly<Record<string, unknown>>): SeedItem {
  const clockId = typeof fields.clockId === "string" ? fields.clockId : undefined;
  return { entity, ...seedStamp(clockId), ...fields };
}

export interface InstanceOptions {
  readonly worldEpoch: number;
  /** Thread address of every operation of the world, by operation id (filled while instantiating). */
  readonly threads?: Map<string, string>;
}

/** Places a complete entity at its key with its GSI attributes. */
export function keyed(item: SeedItem): SeedItem {
  const entity = item.entity as EntityName;
  const key = expectedKey(entity, item);
  if (key === undefined) throw new RangeError(`${entity} is not seedable`);
  return { ...item, ...key, ...expectedIndexAttributes(entity, item) };
}

async function complete(item: SeedItem, options: InstanceOptions, threads: Map<string, string>): Promise<SeedItem> {
  switch (item.entity) {
    case "Operation": {
      const thread = await seedThread(String(item.operationNumber), String(item.clockId), options.worldEpoch);
      threads.set(String(item.operationId), thread.threadAddress);
      return { ...item, worldEpoch: options.worldEpoch, ...thread };
    }
    case "Importer":
      return { ...item, phoneHash: seedPhoneHash(String(item.phoneE164)) };
    case "SupplierContact":
      return { ...item, emailHash: seedEmailHash(String(item.email)) };
    default:
      return item;
  }
}

function fillThread(item: SeedItem, threads: ReadonlyMap<string, string>): SeedItem {
  if (item.entity !== "Message" && item.entity !== "MailboxMessage") return item;
  const address = threads.get(String(item.operationId));
  const fill = (value: unknown): unknown => {
    if (value !== THREAD_ADDRESS_PLACEHOLDER) return value;
    if (address === undefined) throw new RangeError(`no thread address for ${String(item.operationId)}`);
    return address;
  };
  return { ...item, from: fill(item.from), to: fill(item.to) };
}

/** Instance items of one world at `worldEpoch`, with the seed's test key. Order is kept. */
export async function instantiate(items: readonly SeedItem[], options: InstanceOptions): Promise<SeedItem[]> {
  const threads = options.threads ?? new Map<string, string>();
  const completed: SeedItem[] = [];
  for (const item of items) completed.push(await complete(item, options, threads));
  return completed.map((item) => keyed(fillThread(item, threads)));
}
