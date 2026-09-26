// In-memory TableClient with the semantics of dynamo/client.ts: primary and GSI queries (sparse
// GSIs included), filters, conditional writes, optimistic locking, string sets, list appends,
// numeric ADD and all-or-nothing transactions. The unit tests, the local flows (`LF`) and the local
// UI server run the same repositories over it.
import { ConnectorError } from "@legajo/shared";
import type { TableName } from "../../lib/resource";
import {
  MAX_TRANSACT_OPS,
  RESERVED_ATTRIBUTES,
  indexKeys,
  type Item,
  type Key,
  type Predicates,
  type QuerySpec,
  type RangeCondition,
  type TableClient,
  type TransactOp,
  type UpdateOptions,
  type UpdateSpec,
  type WriteCondition,
} from "../table-client";

const rowId = (key: Key): string => `${key.PK}\u0000${key.SK}`;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stringAttribute(item: Item, attribute: string): string | undefined {
  const value = item[attribute];
  return typeof value === "string" ? value : undefined;
}

function matchesRange(value: string, range: RangeCondition): boolean {
  if ("prefix" in range) return value.startsWith(range.prefix);
  if ("between" in range) return value >= range.between[0] && value <= range.between[1];
  if ("gte" in range) return value >= range.gte;
  if ("lte" in range) return value <= range.lte;
  if ("lt" in range) return value < range.lt;
  return value === range.eq;
}

function matchesPredicates(item: Item | undefined, predicates: Predicates | undefined): boolean {
  if (!predicates) return true;
  for (const [attribute, value] of Object.entries(predicates.equals ?? {})) if (item?.[attribute] !== value) return false;
  for (const attribute of predicates.absent ?? []) if (item?.[attribute] !== undefined) return false;
  if (predicates.oneOf) {
    const { attribute, prefixes = [], values = [] } = predicates.oneOf;
    const value = item?.[attribute];
    if (typeof value !== "string") return false;
    if (!prefixes.some((prefix) => value.startsWith(prefix)) && !values.includes(value)) return false;
  }
  return true;
}

function conditionHolds(existing: Item | undefined, cond: WriteCondition | undefined): boolean {
  if (!cond) return true;
  if (cond.ifNotExists && existing !== undefined) return false;
  if (cond.ifExists && existing === undefined) return false;
  if (cond.ifVersion !== undefined && existing?.version !== cond.ifVersion) return false;
  if (cond.ifAbsentOrExpiredAt !== undefined && existing !== undefined) {
    const expiresAt = existing.expiresAt;
    if (typeof expiresAt !== "number" || expiresAt > cond.ifAbsentOrExpiredAt) return false;
  }
  if (cond.atMost) {
    const current = existing?.[cond.atMost.attribute];
    if (typeof current === "number" && current > cond.atMost.value) return false;
  }
  return matchesPredicates(existing, cond);
}

function conflict(table: TableName, key: Key): ConnectorError {
  return new ConnectorError("CONFLICT", `condition failed on ${table} ${key.PK}/${key.SK}`, table);
}

function assertWritable(attribute: string, seen: Set<string>): void {
  if (RESERVED_ATTRIBUTES.has(attribute)) throw new RangeError(`attribute ${attribute} is managed by the connector`);
  if (seen.has(attribute)) throw new RangeError(`attribute ${attribute} appears twice in one update`);
  seen.add(attribute);
}

function asSet(value: unknown): Set<string> {
  if (value instanceof Set) return new Set([...value].map(String));
  return new Set();
}

// Same order and checks as expressions.ts `updateExpression`, applied to a copy of the row.
function applyUpdate(existing: Item | undefined, key: Key, spec: UpdateSpec, updatedAt: string, keepVersion: boolean): Item {
  const next: Record<string, unknown> = existing ? { ...existing } : { PK: key.PK, SK: key.SK };
  const seen = new Set<string>();
  for (const [attribute, value] of Object.entries(spec.set ?? {})) {
    if (value === undefined) continue;
    assertWritable(attribute, seen);
    if (value === null) delete next[attribute];
    else next[attribute] = clone(value);
  }
  for (const [attribute, value] of Object.entries(spec.setIfAbsent ?? {})) {
    if (value === undefined || value === null) continue;
    assertWritable(attribute, seen);
    if (next[attribute] === undefined) next[attribute] = clone(value);
  }
  for (const [attribute, items] of Object.entries(spec.append ?? {})) {
    assertWritable(attribute, seen);
    const current = Array.isArray(next[attribute]) ? (next[attribute] as unknown[]) : [];
    next[attribute] = [...current, ...clone([...items])];
  }
  for (const [attribute, delta] of Object.entries(spec.add ?? {})) {
    assertWritable(attribute, seen);
    const current = next[attribute];
    next[attribute] = (typeof current === "number" ? current : 0) + delta;
  }
  for (const [attribute, elements] of Object.entries(spec.addToSet ?? {})) {
    if (elements.length === 0) continue;
    assertWritable(attribute, seen);
    next[attribute] = new Set([...asSet(next[attribute]), ...elements]);
  }
  for (const [attribute, elements] of Object.entries(spec.deleteFromSet ?? {})) {
    if (elements.length === 0) continue;
    assertWritable(attribute, seen);
    const remaining = asSet(next[attribute]);
    for (const element of elements) remaining.delete(element);
    if (remaining.size === 0) delete next[attribute];
    else next[attribute] = remaining;
  }
  next.updatedAt = updatedAt;
  if (!keepVersion) next.version = (typeof next.version === "number" ? next.version : 0) + 1;
  return { ...next, PK: key.PK, SK: key.SK };
}

export class MemoryTableClient implements TableClient {
  private tables = new Map<TableName, Map<string, Item>>();

  private rows(table: TableName): Map<string, Item> {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = new Map();
      this.tables.set(table, rows);
    }
    return rows;
  }

  /** Test helper: every stored row of a table, in key order. */
  dump(table: TableName): Item[] {
    return [...this.rows(table).values()].map(clone).sort((a, b) => (rowId(a) < rowId(b) ? -1 : rowId(a) > rowId(b) ? 1 : 0));
  }

  clear(): void {
    this.tables.clear();
  }

  async get(table: TableName, key: Key): Promise<Item | undefined> {
    const row = this.rows(table).get(rowId(key));
    return row ? clone(row) : undefined;
  }

  async query(table: TableName, spec: QuerySpec): Promise<Item[]> {
    const keys = spec.index ? indexKeys(table, spec.index) : { hash: "PK", range: "SK" };
    if (spec.range && !keys.range) throw new RangeError(`index ${spec.index ?? "primary"} of ${table} has no range key`);
    const rangeAttribute = keys.range;
    const matches = [...this.rows(table).values()].filter((item) => {
      if (stringAttribute(item, keys.hash) !== spec.hashValue) return false;
      if (rangeAttribute !== undefined) {
        // A GSI only holds rows that carry both of its key attributes (sparse index).
        const rangeValue = stringAttribute(item, rangeAttribute);
        if (rangeValue === undefined) return false;
        if (spec.range && !matchesRange(rangeValue, spec.range)) return false;
      }
      return matchesPredicates(item, spec.filter);
    });
    const sortBy = rangeAttribute ?? "SK";
    matches.sort((a, b) => {
      const left = stringAttribute(a, sortBy) ?? "";
      const right = stringAttribute(b, sortBy) ?? "";
      if (left !== right) return left < right ? -1 : 1;
      // Ties inside a GSI come back in primary-key order, as DynamoDB does for equal range values.
      return rowId(a) < rowId(b) ? -1 : rowId(a) > rowId(b) ? 1 : 0;
    });
    if (spec.descending) matches.reverse();
    const limited = spec.limit === undefined ? matches : matches.slice(0, spec.limit);
    return limited.map(clone);
  }

  async put(table: TableName, item: Item, cond?: WriteCondition): Promise<void> {
    const rows = this.rows(table);
    if (!conditionHolds(rows.get(rowId(item)), cond)) throw conflict(table, item);
    rows.set(rowId(item), clone(item));
  }

  async update(table: TableName, key: Key, spec: UpdateSpec, updatedAt: string, options: UpdateOptions = {}): Promise<Item> {
    const rows = this.rows(table);
    const existing = rows.get(rowId(key));
    const creating = options.upsert === true || options.condition?.ifNotExists === true;
    if (existing === undefined && !creating) throw new ConnectorError("NOT_FOUND", `${table} item ${key.PK}/${key.SK} not found`, table);
    if (!conditionHolds(existing, options.condition)) throw conflict(table, key);
    const next = applyUpdate(existing, key, spec, updatedAt, options.keepVersion === true);
    rows.set(rowId(key), next);
    return clone(next);
  }

  async delete(table: TableName, key: Key, cond?: WriteCondition): Promise<void> {
    const rows = this.rows(table);
    if (!conditionHolds(rows.get(rowId(key)), cond)) throw conflict(table, key);
    rows.delete(rowId(key));
  }

  // Every condition is checked against a snapshot before anything is kept, so a failed operation
  // leaves nothing behind, like TransactWriteItems.
  async transact(ops: readonly TransactOp[]): Promise<void> {
    if (ops.length > MAX_TRANSACT_OPS) throw new ConnectorError("VALIDATION", `a transaction takes at most ${MAX_TRANSACT_OPS} operations`);
    const snapshot = new Map([...this.tables].map(([table, rows]) => [table, new Map(rows)] as const));
    try {
      for (const op of ops) {
        switch (op.op) {
          case "put":
            await this.put(op.table, op.item, op.condition);
            break;
          case "update":
            await this.update(op.table, op.key, op.spec, op.updatedAt, op.options);
            break;
          case "delete":
            await this.delete(op.table, op.key, op.condition);
            break;
          case "check":
            if (!conditionHolds(this.rows(op.table).get(rowId(op.key)), op.condition)) throw conflict(op.table, op.key);
            break;
        }
      }
    } catch (error) {
      this.tables = snapshot;
      if (error instanceof ConnectorError) throw new ConnectorError("CONFLICT", `transaction cancelled: ${error.message}`, error.table, { cause: error });
      throw error;
    }
  }

  async batchPut(table: TableName, items: readonly Item[]): Promise<void> {
    for (const item of items) await this.put(table, item);
  }

  async batchDelete(table: TableName, keys: readonly Key[]): Promise<void> {
    for (const key of keys) await this.delete(table, key);
  }
}
