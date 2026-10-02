// Every item a world wrote, found from its clock (docs/architecture.md §8, "Reiniciar demo"): the
// partitions of its operations (`META`, documents and versions, observations, escalations, timers),
// their conversations, decisions, address claims and `OPSTATE#`; its importers and suppliers with their
// consents, authorizations, contacts, profiles and claims; the demo mailboxes of the firm and of the
// suppliers (only the rows of this world); its firm-level decisions; its metrics; and `WORLDSTATE#` and
// `PENDING#` of its clock. What a reset keeps is never listed here: the `Firms` rows (the template
// rewrites them and the brokers keep their Cognito `sub`), `CLOCK#`, `COUNTER#EPOCH#`, tombstones, the
// guest quotas and leases. Short-lived `Runtime` rows keyed by random ids (sessions, turns, nonces,
// links, idempotency marks, rate counters) expire by TTL and name an epoch that no longer resolves.
import type { Connector } from "../connector/connector";
import { addressClaimKey, auditPartition, firmPartition, importerPartition, mailboxPartition, opAuditKey, opStateKey, operationPartition, pendingPartition, supplierPartition, worldStateKey } from "../connector/keys";
import type { Item, Key, TableClient } from "../connector/table-client";
import type { TableName } from "../lib/resource";

export interface WorldItemsDeps {
  readonly client: TableClient;
  readonly data: Pick<Connector, "operations" | "parties" | "firms">;
  /** Keyed hash of an address (`email-hash` subkey): the `ADDR#` claim of a thread address or a mailbox. */
  readonly addressHash: (address: string) => string;
}

export interface WorldRef {
  readonly clockId: string;
  readonly firmId: string;
  /** Simulated span of the world's decisions (`AuditLog` is partitioned by the month of `ts`). */
  readonly fromSim: string;
  readonly toSim: string;
  /** Demo mailboxes of the world besides the firm's and its suppliers' (a QA world's own firm mailbox). */
  readonly mailboxes?: readonly string[];
}

export type DeletedCounts = Readonly<Partial<Record<TableName, number>>>;

const keyOf = (item: Item): Key => ({ PK: item.PK, SK: item.SK });

/** At most three years of a world's decisions are looked for. */
const MAX_MONTHS = 36;

/** `yyyy-mm` (UTC) of every month from `fromSim` to `toSim`, both included. */
export function monthsBetween(fromSim: string, toSim: string): string[] {
  const from = new Date(Date.parse(fromSim));
  const to = new Date(Date.parse(toSim));
  const last = to.getUTCFullYear() * 12 + to.getUTCMonth();
  const months: string[] = [];
  for (let index = from.getUTCFullYear() * 12 + from.getUTCMonth(); index <= last && months.length < MAX_MONTHS; index += 1) {
    months.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`);
  }
  return months;
}

class Collector {
  private readonly keys = new Map<TableName, Map<string, Key>>();

  add(table: TableName, keys: readonly Key[]): void {
    const bucket = this.keys.get(table) ?? new Map<string, Key>();
    for (const key of keys) bucket.set(`${key.PK}\u0000${key.SK}`, key);
    this.keys.set(table, bucket);
  }

  entries(): Array<[TableName, Key[]]> {
    return [...this.keys.entries()].map(([table, keys]) => [table, [...keys.values()]]);
  }
}

async function partition(client: TableClient, table: TableName, hashValue: string): Promise<Key[]> {
  return (await client.query(table, { hashValue })).map(keyOf);
}

/** A claim row only if `ownerId` still holds it (a claim of another world is never touched). */
async function claimOf(client: TableClient, addressHash: string, ownerId: string): Promise<Key[]> {
  const key = addressClaimKey(addressHash);
  const row = await client.get("Parties", key);
  return row?.ownerId === ownerId ? [key] : [];
}

async function mailboxRows(client: TableClient, address: string, clockId: string): Promise<Key[]> {
  return (await client.query("Conversations", { hashValue: mailboxPartition(address), filter: { equals: { clockId } } })).map(keyOf);
}

async function collectOperations(world: WorldRef, deps: WorldItemsDeps, keys: Collector): Promise<void> {
  const { client } = deps;
  const operations = await deps.data.operations.listOperations(world.firmId, { clockId: world.clockId });
  for (const operation of operations) {
    keys.add("Operations", await partition(client, "Operations", operationPartition(operation.operationId)));
    keys.add("Conversations", await partition(client, "Conversations", operationPartition(operation.operationId)));
    keys.add("AuditLog", (await client.query("AuditLog", { index: "GSI1", hashValue: opAuditKey(operation.operationId) })).map(keyOf));
    keys.add("Runtime", [opStateKey(operation.operationId)]);
    keys.add("Parties", await claimOf(client, deps.addressHash(operation.threadAddress), operation.operationId));
  }
}

async function collectParties(world: WorldRef, deps: WorldItemsDeps, keys: Collector): Promise<void> {
  const { client, data } = deps;
  for (const importer of await data.parties.listImporters(world.firmId, { clockId: world.clockId })) {
    keys.add("Parties", await partition(client, "Parties", importerPartition(importer.importerId)));
    keys.add("Parties", await claimOf(client, importer.phoneHash, importer.importerId));
  }
  for (const supplier of await data.parties.listSuppliers(world.firmId, { clockId: world.clockId })) {
    const contacts = await data.parties.listContacts(supplier.supplierId);
    keys.add("Parties", await partition(client, "Parties", supplierPartition(supplier.supplierId)));
    for (const contact of contacts) {
      keys.add("Parties", await claimOf(client, contact.emailHash, contact.contactId));
      keys.add("Conversations", await mailboxRows(client, contact.email, world.clockId));
    }
  }
}

async function collectWorldLevel(world: WorldRef, deps: WorldItemsDeps, keys: Collector): Promise<void> {
  const { client } = deps;
  const firm = await deps.data.firms.findFirm(world.firmId);
  for (const address of new Set([...(firm === undefined ? [] : [firm.mailboxAddress]), ...(world.mailboxes ?? [])])) {
    keys.add("Conversations", await mailboxRows(client, address, world.clockId));
  }
  for (const month of monthsBetween(world.fromSim, world.toSim)) {
    keys.add("AuditLog", (await client.query("AuditLog", { hashValue: auditPartition(world.firmId, month), filter: { equals: { clockId: world.clockId } } })).map(keyOf));
  }
  for (const source of ["WORLD", "BATCH"]) {
    keys.add("LegajoMetrics", (await client.query("LegajoMetrics", { hashValue: firmPartition(world.firmId), range: { prefix: `${source}#${world.clockId}#` } })).map(keyOf));
  }
  keys.add("Runtime", [worldStateKey(world.clockId), ...(await partition(client, "Runtime", pendingPartition(world.clockId)))]);
}

/** Deletes every item of the world (see the header for what stays); answers how many per table. */
export async function purgeWorldItems(world: WorldRef, deps: WorldItemsDeps): Promise<DeletedCounts> {
  const keys = new Collector();
  await collectOperations(world, deps, keys);
  await collectParties(world, deps, keys);
  await collectWorldLevel(world, deps, keys);
  const counts: Partial<Record<TableName, number>> = {};
  for (const [table, tableKeys] of keys.entries()) {
    if (tableKeys.length === 0) continue;
    await deps.client.batchDelete(table, tableKeys);
    counts[table] = tableKeys.length;
  }
  return counts;
}
