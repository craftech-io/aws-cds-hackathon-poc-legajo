// Helpers every repository shares: the context (table client, injected real clock, id generator),
// stamping the metadata and world stamp of a new row, validating rows with their entity schema in
// both directions (zod at the connector edge, CLAUDE.md), typed NOT_FOUND and version pinning.
import type { z } from "zod";
import { ConnectorError } from "@legajo/shared";
import { clockTtlSeconds, epochSecondsAfter, worldOfClock, type EntityName } from "../../domain/common";
import type { TableName } from "../../lib/resource";
import { TTL_ATTRIBUTE, type Item, type Key, type TableClient, type UpdateOptions, type UpdateSpec, type WriteCondition } from "../table-client";

export interface RepoContext {
  readonly client: TableClient;
  /**
   * Real time, for what is real by definition: `createdAt`/`updatedAt`, TTLs and real-time stamps.
   * Business times (`…Sim`) always come from the caller, who reads the world clock (ADR-0007).
   */
  readonly now: () => Date;
  /** Id generator for rows the connector names itself (decisions, escalations, results). */
  readonly newId: () => string;
}

export function nowIso(ctx: RepoContext): string {
  return ctx.now().toISOString();
}

export interface StampOptions {
  /** Attributes that only exist for a GSI (`firmStatusKey`, `counterpartKey`…). */
  readonly gsi?: Readonly<Record<string, unknown>>;
  /** Table TTL of the entity; the shorter of it and the world's TTL wins. */
  readonly ttlSeconds?: number;
}

/** `world` and `expiresAt` of a new item of a world, and the shorter of its TTLs. */
export function worldStamp(ctx: RepoContext, fields: Readonly<Record<string, unknown>>, ttlSeconds?: number): Record<string, unknown> {
  const stamp: Record<string, unknown> = {};
  const clockId = typeof fields.clockId === "string" ? fields.clockId : undefined;
  const world = clockId === undefined ? undefined : worldOfClock(clockId);
  if (world !== undefined && fields.world === undefined) stamp.world = world;
  if (fields[TTL_ATTRIBUTE] === undefined) {
    const ttls = [ttlSeconds, clockId === undefined ? undefined : clockTtlSeconds(clockId)].filter((value): value is number => value !== undefined);
    if (ttls.length > 0) stamp[TTL_ATTRIBUTE] = epochSecondsAfter(ctx.now(), Math.min(...ttls));
  }
  return stamp;
}

/** A brand-new row: key, entity discriminator, fields, metadata, GSI attributes and world stamp. */
export function stampNew(ctx: RepoContext, entity: EntityName, key: Key, fields: Readonly<Record<string, unknown>>, options: StampOptions = {}): Item {
  const at = nowIso(ctx);
  return {
    synthetic: false,
    ...fields,
    ...worldStamp(ctx, fields, options.ttlSeconds),
    ...options.gsi,
    PK: key.PK,
    SK: key.SK,
    entity,
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
}

/**
 * `setIfAbsent` of an upsert (counters, in-flight sets): what a new row gets and an existing one
 * keeps: the discriminator, its identity fields, `createdAt` and the world stamp.
 */
export function creationDefaults(ctx: RepoContext, entity: EntityName, fields: Readonly<Record<string, unknown>>, ttlSeconds?: number): Record<string, unknown> {
  return { ...fields, ...worldStamp(ctx, fields, ttlSeconds), entity, createdAt: nowIso(ctx), synthetic: false };
}

function invalid(table: TableName, what: string, error: z.ZodError): ConnectorError {
  const detail = error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return new ConnectorError("VALIDATION", `${what} on ${table}: ${detail}`, table, { cause: error });
}

/** Parses a value the adapter builds from a caller's input (a history entry); a bad input is VALIDATION. */
export function checked<T>(schema: z.ZodType<T>, table: TableName, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(table, "invalid input", parsed.error);
  return parsed.data;
}

export function parseEntity<T>(schema: z.ZodType<T>, entity: EntityName, item: Item, table: TableName): T {
  if (item.entity !== entity) throw new ConnectorError("VALIDATION", `${table} item ${item.PK}/${item.SK} is ${String(item.entity)}, expected ${entity}`, table);
  const parsed = schema.safeParse(item);
  if (!parsed.success) throw invalid(table, `stored ${entity} ${item.PK}/${item.SK} is invalid`, parsed.error);
  return parsed.data;
}

export function parseEntities<T>(schema: z.ZodType<T>, entity: EntityName, items: readonly Item[], table: TableName): T[] {
  return items.map((item) => parseEntity(schema, entity, item, table));
}

export function optionalEntity<T>(schema: z.ZodType<T>, entity: EntityName, item: Item | undefined, table: TableName): T | undefined {
  return item === undefined ? undefined : parseEntity(schema, entity, item, table);
}

export function requireEntity<T>(schema: z.ZodType<T>, entity: EntityName, item: Item | undefined, table: TableName, what: string): T {
  if (item === undefined) throw new ConnectorError("NOT_FOUND", `${what} not found`, table);
  return parseEntity(schema, entity, item, table);
}

/** Stamps a new row and validates the whole row with its schema before anything is stored. */
export function buildRow<T>(ctx: RepoContext, table: TableName, schema: z.ZodType<T>, entity: EntityName, key: Key, fields: Readonly<Record<string, unknown>>, options: StampOptions = {}): { item: Item; value: T } {
  const item = stampNew(ctx, entity, key, fields, options);
  const parsed = schema.safeParse(item);
  if (!parsed.success) throw invalid(table, `invalid ${entity}`, parsed.error);
  return { item, value: parsed.data };
}

export interface CreateOptions extends StampOptions {
  /** Defaults to `{ ifNotExists: true }`: creating over an existing key is a CONFLICT. */
  readonly condition?: WriteCondition;
}

/** Validates, stamps and stores a new entity; returns it parsed through its schema. */
export async function createRow<T>(ctx: RepoContext, table: TableName, schema: z.ZodType<T>, entity: EntityName, key: Key, fields: Readonly<Record<string, unknown>>, options: CreateOptions = {}): Promise<T> {
  const { item, value } = buildRow(ctx, table, schema, entity, key, fields, options);
  await ctx.client.put(table, item, options.condition ?? { ifNotExists: true });
  return value;
}

/**
 * Replaces a whole row that code recomputes (a measured profile), keeping `createdAt` and pinning
 * the write to the version it read (or to the key being absent).
 */
export async function replaceRow<T>(ctx: RepoContext, table: TableName, schema: z.ZodType<T>, entity: EntityName, key: Key, fields: Readonly<Record<string, unknown>>, options: StampOptions = {}): Promise<T> {
  const existing = await ctx.client.get(table, key);
  const { item } = buildRow(ctx, table, schema, entity, key, fields, options);
  if (existing === undefined) {
    await ctx.client.put(table, item, { ifNotExists: true });
  } else {
    const version = typeof existing.version === "number" ? existing.version : 0;
    const replaced: Item = { ...item, createdAt: existing.createdAt, version: version + 1 };
    await ctx.client.put(table, replaced, { ifVersion: version });
    return parseEntity(schema, entity, replaced, table);
  }
  return parseEntity(schema, entity, item, table);
}

/** Validates a patch against the fields it touches before anything is written. */
export function checkPatch(schema: z.ZodObject, patch: Readonly<Record<string, unknown>>, table: TableName, what: string): Record<string, unknown> {
  const fields = defined(patch);
  const parsed = schema.partial().strict().safeParse(fields);
  if (!parsed.success) throw invalid(table, `invalid patch of ${what}`, parsed.error);
  return fields;
}

/** Applies an update and returns the stored entity, re-validated. */
export async function updateRow<T>(ctx: RepoContext, table: TableName, schema: z.ZodType<T>, entity: EntityName, key: Key, spec: UpdateSpec, options: UpdateOptions = {}): Promise<T> {
  const item = await ctx.client.update(table, key, spec, nowIso(ctx), options);
  return parseEntity(schema, entity, item, table);
}

/**
 * The version a transition is pinned to: the caller's (read earlier in the same request) or the
 * one just read. Either way the write is conditional on it (optimistic locking, §5).
 */
export async function pinnedVersion(ctx: RepoContext, table: TableName, key: Key, expectedVersion: number | undefined, what: string): Promise<number> {
  if (expectedVersion !== undefined) return expectedVersion;
  const current = await ctx.client.get(table, key);
  if (current === undefined) throw new ConnectorError("NOT_FOUND", `${what} not found`, table);
  if (typeof current.version !== "number") throw new ConnectorError("VALIDATION", `${what} has no version`, table);
  return current.version;
}

/** Drops `undefined` values so a patch never removes what the caller did not mention. */
export function defined(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
