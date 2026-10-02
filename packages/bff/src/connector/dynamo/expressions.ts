// Builds DynamoDB expressions from the semantic specs of table-client.ts: the one place that knows
// about placeholders, `begins_with`, `attribute_not_exists`, optimistic locking, string sets and
// `list_append`. Every value goes through a placeholder, never into the expression text.
import type { TableName } from "../../lib/resource";
import {
  RESERVED_ATTRIBUTES,
  indexKeys,
  type Predicates,
  type QuerySpec,
  type RangeCondition,
  type UpdateOptions,
  type UpdateSpec,
  type WriteCondition,
} from "../table-client";

export interface Expression {
  readonly names: Record<string, string>;
  readonly values: Record<string, unknown>;
}

export class Placeholders {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, unknown> = {};
  private counter = 0;

  name(attribute: string): string {
    const existing = Object.entries(this.names).find(([, value]) => value === attribute);
    if (existing) return existing[0];
    const placeholder = `#n${this.counter++}`;
    this.names[placeholder] = attribute;
    return placeholder;
  }

  value(value: unknown): string {
    const placeholder = `:v${this.counter++}`;
    this.values[placeholder] = value;
    return placeholder;
  }
}

function rangeClause(ph: Placeholders, attribute: string, range: RangeCondition): string {
  const name = ph.name(attribute);
  if ("prefix" in range) return `begins_with(${name}, ${ph.value(range.prefix)})`;
  if ("between" in range) return `${name} BETWEEN ${ph.value(range.between[0])} AND ${ph.value(range.between[1])}`;
  if ("gte" in range) return `${name} >= ${ph.value(range.gte)}`;
  if ("lte" in range) return `${name} <= ${ph.value(range.lte)}`;
  if ("lt" in range) return `${name} < ${ph.value(range.lt)}`;
  return `${name} = ${ph.value(range.eq)}`;
}

export interface KeyConditionExpression extends Expression {
  readonly expression: string;
  readonly indexName?: string;
  readonly filterExpression?: string;
}

export function keyCondition(table: TableName, spec: QuerySpec): KeyConditionExpression {
  const ph = new Placeholders();
  const keys = spec.index ? indexKeys(table, spec.index) : { hash: "PK", range: "SK" };
  const clauses = [`${ph.name(keys.hash)} = ${ph.value(spec.hashValue)}`];
  if (spec.range) {
    if (!keys.range) throw new RangeError(`index ${spec.index ?? "primary"} of ${table} has no range key`);
    clauses.push(rangeClause(ph, keys.range, spec.range));
  }
  const filter = predicateClauses(ph, spec.filter);
  const base = { expression: clauses.join(" AND "), names: ph.names, values: ph.values };
  const withIndex = spec.index === undefined ? base : { ...base, indexName: spec.index };
  return filter.length === 0 ? withIndex : { ...withIndex, filterExpression: filter.join(" AND ") };
}

function predicateClauses(ph: Placeholders, predicates: Predicates | undefined): string[] {
  if (!predicates) return [];
  const clauses: string[] = [];
  for (const [attribute, value] of Object.entries(predicates.equals ?? {})) clauses.push(`${ph.name(attribute)} = ${ph.value(value)}`);
  for (const attribute of predicates.absent ?? []) clauses.push(`attribute_not_exists(${ph.name(attribute)})`);
  if (predicates.oneOf) {
    const { attribute, prefixes = [], values = [] } = predicates.oneOf;
    const name = ph.name(attribute);
    const options = [...prefixes.map((prefix) => `begins_with(${name}, ${ph.value(prefix)})`), ...values.map((value) => `${name} = ${ph.value(value)}`)];
    if (options.length === 0) throw new RangeError(`oneOf on ${attribute} needs a prefix or a value`);
    clauses.push(options.length === 1 ? (options[0] ?? "") : `(${options.join(" OR ")})`);
  }
  return clauses;
}

/** `FilterExpression` of a scan; `undefined` without predicates. */
export function scanFilter(predicates: Predicates | undefined): Expression & { readonly expression: string | undefined } {
  const ph = new Placeholders();
  const clauses = predicateClauses(ph, predicates);
  return { expression: clauses.length > 0 ? clauses.join(" AND ") : undefined, names: ph.names, values: ph.values };
}

export interface ConditionExpression extends Expression {
  readonly expression: string | undefined;
}

export function condition(cond: WriteCondition | undefined, ph = new Placeholders()): ConditionExpression {
  const clauses: string[] = [];
  if (cond?.ifNotExists) clauses.push(`attribute_not_exists(${ph.name("PK")})`);
  if (cond?.ifExists) clauses.push(`attribute_exists(${ph.name("PK")})`);
  if (cond?.ifVersion !== undefined) clauses.push(`${ph.name("version")} = ${ph.value(cond.ifVersion)}`);
  if (cond?.ifAbsentOrExpiredAt !== undefined) {
    clauses.push(`(attribute_not_exists(${ph.name("PK")}) OR ${ph.name("expiresAt")} <= ${ph.value(cond.ifAbsentOrExpiredAt)})`);
  }
  if (cond?.atMost) {
    const counter = ph.name(cond.atMost.attribute);
    clauses.push(`(attribute_not_exists(${counter}) OR ${counter} <= ${ph.value(cond.atMost.value)})`);
  }
  clauses.push(...predicateClauses(ph, cond));
  return { expression: clauses.length > 0 ? clauses.join(" AND ") : undefined, names: ph.names, values: ph.values };
}

export interface UpdateExpression extends Expression {
  readonly expression: string;
  readonly conditionExpression: string | undefined;
}

function assertWritable(attribute: string, seen: Set<string>): void {
  if (RESERVED_ATTRIBUTES.has(attribute)) throw new RangeError(`attribute ${attribute} is managed by the connector`);
  if (seen.has(attribute)) throw new RangeError(`attribute ${attribute} appears twice in one update`);
  seen.add(attribute);
}

/**
 * SET, REMOVE, ADD and DELETE from an UpdateSpec, plus `updatedAt` and `version + 1` (unless
 * `keepVersion`). Without `upsert` the row must exist (`attribute_exists(PK)` joins the condition).
 */
export function updateExpression(spec: UpdateSpec, updatedAt: string, options: UpdateOptions = {}): UpdateExpression {
  const cond = options.condition;
  const ph = new Placeholders();
  const seen = new Set<string>();
  const sets: string[] = [];
  const removes: string[] = [];
  const adds: string[] = [];
  const deletes: string[] = [];
  for (const [attribute, value] of Object.entries(spec.set ?? {})) {
    if (value === undefined) continue;
    assertWritable(attribute, seen);
    if (value === null) removes.push(ph.name(attribute));
    else sets.push(`${ph.name(attribute)} = ${ph.value(value)}`);
  }
  for (const [attribute, value] of Object.entries(spec.setIfAbsent ?? {})) {
    if (value === undefined || value === null) continue;
    assertWritable(attribute, seen);
    const name = ph.name(attribute);
    sets.push(`${name} = if_not_exists(${name}, ${ph.value(value)})`);
  }
  for (const [attribute, items] of Object.entries(spec.append ?? {})) {
    assertWritable(attribute, seen);
    const name = ph.name(attribute);
    sets.push(`${name} = list_append(if_not_exists(${name}, ${ph.value([])}), ${ph.value([...items])})`);
  }
  for (const [attribute, delta] of Object.entries(spec.add ?? {})) {
    assertWritable(attribute, seen);
    adds.push(`${ph.name(attribute)} ${ph.value(delta)}`);
  }
  for (const [attribute, elements] of Object.entries(spec.addToSet ?? {})) {
    if (elements.length === 0) continue;
    assertWritable(attribute, seen);
    adds.push(`${ph.name(attribute)} ${ph.value(new Set(elements))}`);
  }
  for (const [attribute, elements] of Object.entries(spec.deleteFromSet ?? {})) {
    if (elements.length === 0) continue;
    assertWritable(attribute, seen);
    deletes.push(`${ph.name(attribute)} ${ph.value(new Set(elements))}`);
  }
  sets.push(`${ph.name("updatedAt")} = ${ph.value(updatedAt)}`);
  if (options.keepVersion !== true) {
    const version = ph.name("version");
    sets.push(`${version} = if_not_exists(${version}, ${ph.value(0)}) + ${ph.value(1)}`);
  }
  const parts = [`SET ${sets.join(", ")}`];
  if (removes.length > 0) parts.push(`REMOVE ${removes.join(", ")}`);
  if (adds.length > 0) parts.push(`ADD ${adds.join(", ")}`);
  if (deletes.length > 0) parts.push(`DELETE ${deletes.join(", ")}`);
  const effective: WriteCondition | undefined = options.upsert === true || cond?.ifNotExists ? cond : { ifExists: true, ...cond };
  const conditionPart = condition(effective, ph);
  return { expression: parts.join(" "), conditionExpression: conditionPart.expression, names: ph.names, values: ph.values };
}

/** Drops the placeholder maps when they are empty (DynamoDB rejects empty maps). */
export function omitEmpty<T extends Record<string, unknown>>(map: T): T | undefined {
  return Object.keys(map).length > 0 ? map : undefined;
}
