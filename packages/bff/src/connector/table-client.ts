// Storage primitive under the connector: a semantic, expression-free view of a DynamoDB table.
// The repositories in dynamo/*.ts speak only this interface, so the same repository code runs over
// the DocumentClient (dynamo/client.ts) in a Lambda and over a map (memory/table-client.ts) in the
// tests and the local flows. Keys, GSIs and TTL mirror infra/storage-keys.ts (WP-06), which
// connector/boundary.test.ts compares.
import type { TableName } from "../lib/resource";

/** Every table is keyed by `PK` + `SK` (strings). */
export interface Key {
  readonly PK: string;
  readonly SK: string;
}

/** A stored row: the key, the `entity` discriminator and whatever the entity carries. */
export type Item = Key & Record<string, unknown>;

/** TTL attribute of every table, in epoch seconds (a Number; DynamoDB ignores any other type). */
export const TTL_ATTRIBUTE = "expiresAt";

export type IndexName = "GSI1" | "GSI2" | "GSI3";

export interface IndexKeys {
  readonly hash: string;
  readonly range?: string;
}

/** Global secondary indexes per table, exactly as infra/storage-keys.ts `TABLE_SPECS` declares them. */
export const INDEXES: Readonly<Partial<Record<TableName, Readonly<Partial<Record<IndexName, IndexKeys>>>>>> = {
  Firms: { GSI1: { hash: "cognitoSubKey" } },
  Parties: { GSI1: { hash: "phoneHash" }, GSI2: { hash: "emailHash" }, GSI3: { hash: "firmKey", range: "sortName" } },
  Operations: { GSI1: { hash: "firmStatusKey", range: "etaSort" }, GSI2: { hash: "threadKey" }, GSI3: { hash: "clockDueKey", range: "dueAtSim" } },
  Conversations: { GSI1: { hash: "providerMessageId" }, GSI2: { hash: "counterpartKey", range: "sentAtSim" } },
  AuditLog: { GSI1: { hash: "opKey", range: "ts" }, GSI2: { hash: "decisionKey", range: "ts" } },
};

export function indexKeys(table: TableName, index: IndexName): IndexKeys {
  const keys = INDEXES[table]?.[index];
  if (!keys) throw new RangeError(`table ${table} has no index ${index}`);
  return keys;
}

export type RangeCondition =
  | { readonly prefix: string }
  | { readonly between: readonly [string, string] }
  | { readonly gte: string }
  | { readonly lte: string }
  | { readonly lt: string }
  | { readonly eq: string };

export type Scalar = string | number | boolean;

/** Attribute predicates shared by write conditions and query filters. */
export interface Predicates {
  /** Every listed attribute equals its value. */
  readonly equals?: Readonly<Record<string, Scalar>>;
  /** Every listed attribute is absent. */
  readonly absent?: readonly string[];
  /** The attribute starts with one of `prefixes` or equals one of `values`. */
  readonly oneOf?: { readonly attribute: string; readonly prefixes?: readonly string[]; readonly values?: readonly string[] };
}

export interface QuerySpec {
  /** Omitted: the primary index (PK + SK). */
  readonly index?: IndexName;
  readonly hashValue: string;
  readonly range?: RangeCondition;
  readonly descending?: boolean;
  /** Maximum rows returned, counted after the filter (the adapter pages until it has them). */
  readonly limit?: number;
  readonly filter?: Predicates;
}

/** A whole-table read with a filter: only for the small `Leads` table (exports, sweeps, retention). */
export interface ScanSpec {
  readonly filter?: Predicates;
  /** Maximum rows returned, counted after the filter. */
  readonly limit?: number;
}

export interface WriteCondition extends Predicates {
  /** Fail with CONFLICT when the key already exists (create). */
  readonly ifNotExists?: boolean;
  /** Fail when the key does not exist. */
  readonly ifExists?: boolean;
  /** Optimistic locking: fail with CONFLICT unless the stored `version` matches. */
  readonly ifVersion?: number;
  /** Ceiling of a counter: `attribute_not_exists(a) OR a <= value` (evaluated before the ADD). */
  readonly atMost?: { readonly attribute: string; readonly value: number };
  /** The row is absent or its `expiresAt` is at or before this epoch second (a lease that lapsed). */
  readonly ifAbsentOrExpiredAt?: number;
}

/** Attributes to SET; `null` REMOVEs the attribute; `undefined` is skipped. */
export type Patch = Readonly<Record<string, unknown>>;

/**
 * One UpdateItem. Every update also stamps `updatedAt` and bumps `version`, so any concurrent
 * writer pinned to the previous version fails (docs/architecture.md §5, "Reglas de escritura").
 */
export interface UpdateSpec {
  readonly set?: Patch;
  /** `SET a = if_not_exists(a, v)`: creation defaults of an upsert. */
  readonly setIfAbsent?: Patch;
  /** Numeric `ADD` (created at the delta). */
  readonly add?: Readonly<Record<string, number>>;
  /** `ADD` elements to a string set. */
  readonly addToSet?: Readonly<Record<string, readonly string[]>>;
  /** `DELETE` elements from a string set; the attribute disappears when the set empties. */
  readonly deleteFromSet?: Readonly<Record<string, readonly string[]>>;
  /** `SET l = list_append(if_not_exists(l, []), items)`: dated histories, appended atomically. */
  readonly append?: Readonly<Record<string, readonly unknown[]>>;
}

export interface UpdateOptions {
  readonly condition?: WriteCondition;
  /** Create the row when it is missing; by default a missing row is NOT_FOUND. */
  readonly upsert?: boolean;
  /**
   * Bookkeeping that is not a transition (the name of a timer's schedule) keeps `version`, so a
   * message that carries the version (the schedule's input) stays valid. Still conditional.
   */
  readonly keepVersion?: boolean;
}

export type TransactOp =
  | { readonly op: "put"; readonly table: TableName; readonly item: Item; readonly condition?: WriteCondition }
  | { readonly op: "update"; readonly table: TableName; readonly key: Key; readonly spec: UpdateSpec; readonly updatedAt: string; readonly options?: UpdateOptions }
  | { readonly op: "delete"; readonly table: TableName; readonly key: Key; readonly condition?: WriteCondition }
  | { readonly op: "check"; readonly table: TableName; readonly key: Key; readonly condition: WriteCondition };

/** At most 100 operations per DynamoDB transaction. */
export const MAX_TRANSACT_OPS = 100;

export interface TableClient {
  /** Strongly consistent read by key. */
  get(table: TableName, key: Key): Promise<Item | undefined>;
  /** Pages through the whole result (or until `limit`); GSIs are eventually consistent. */
  query(table: TableName, spec: QuerySpec): Promise<Item[]>;
  /** Pages through the whole table (or until `limit`) with an optional filter; never on a large table. */
  scan(table: TableName, spec?: ScanSpec): Promise<Item[]>;
  put(table: TableName, item: Item, condition?: WriteCondition): Promise<void>;
  /** Applies the spec, stamps `updatedAt`, bumps `version` and returns the stored row. */
  update(table: TableName, key: Key, spec: UpdateSpec, updatedAt: string, options?: UpdateOptions): Promise<Item>;
  delete(table: TableName, key: Key, condition?: WriteCondition): Promise<void>;
  /** All or nothing across tables (TransactWriteItems); CONFLICT when any condition fails. */
  transact(ops: readonly TransactOp[]): Promise<void>;
  /** Unconditional upsert of many rows (seed loader, world factory); retries unprocessed items. */
  batchPut(table: TableName, items: readonly Item[]): Promise<void>;
  /** Unconditional delete of many keys (world reset); conditional deletes go through `delete`. */
  batchDelete(table: TableName, keys: readonly Key[]): Promise<void>;
}

/** Attributes no patch may touch: the key, and what every update stamps itself. */
export const RESERVED_ATTRIBUTES: ReadonlySet<string> = new Set(["PK", "SK", "version", "updatedAt"]);
