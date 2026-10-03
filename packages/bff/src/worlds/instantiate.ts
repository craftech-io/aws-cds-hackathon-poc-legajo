// A template's items made into one world (docs/seed-spec.md §1, §2 and §14): every id, address and
// marker renamed for the world (renames), the world's stamp (`world`, `runId`, `expiresAt`), the fields
// derived from the stage's keys and the world's epoch (thread tag and address with the `thread`
// subkey, `phoneHash` and `emailHash` with theirs), the `{threadAddress}` of the seeded emails filled,
// and each item placed at its key with the GSI attributes the connector gives it
// (connector/item-shape.ts). The seed generator does the same with the seed's test key
// (`scripts/seed/lib/items.ts`); the factory does it with the stage's.
import { computeThreadTag, threadAddress } from "@legajo/shared";
import { expectedIndexAttributes, expectedKey } from "../connector/item-shape";
import type { Item } from "../connector/table-client";
import type { EntityName } from "../domain/common";
import { emailHash, phoneHash, type SecretKey } from "../lib/crypto";
import type { TemplateItem } from "./template";

/** Stands for the operation's thread address in a seeded email (`from`/`to`). */
export const THREAD_ADDRESS_PLACEHOLDER = "{threadAddress}";

/** The stage's subkeys a world is derived with (lib/secrets.ts `subkey`), or a test master's. */
export interface WorldKeys {
  readonly thread: SecretKey;
  readonly phoneHash: SecretKey;
  readonly emailHash: SecretKey;
}

/** Keyed hash of an address, as the claims (`ADDR#`) and the registry compute it. */
export function addressHashOf(keys: WorldKeys, address: string): string {
  return emailHash(keys.emailHash, address);
}

/** How a template's strings become a world's: exact values first, then substrings, then patterns. */
export interface Renames {
  /** Whole values replaced as they are (ids, addresses, phones). */
  readonly exact: ReadonlyMap<string, string>;
  /** Substrings replaced inside every string (the `00` markers of the guest template). */
  readonly substrings: ReadonlyArray<readonly [string, string]>;
  /** Composite ids that embed another id (`dv-4471-CI-1`, `obs-4471-PL-…`). */
  readonly patterns: ReadonlyArray<readonly [RegExp, string]>;
}

export const NO_RENAMES: Renames = { exact: new Map(), substrings: [], patterns: [] };

export function renameString(value: string, renames: Renames): string {
  const exact = renames.exact.get(value);
  if (exact !== undefined) return exact;
  let out = value;
  for (const [from, to] of renames.substrings) if (out.includes(from)) out = out.split(from).join(to);
  for (const [pattern, to] of renames.patterns) out = out.replace(pattern, to);
  return renames.exact.get(out) ?? out;
}

/** Every string of `value`, at any depth, renamed; keys of objects are never renamed. */
export function renameDeep(value: unknown, renames: Renames): unknown {
  if (typeof value === "string") return renameString(value, renames);
  if (Array.isArray(value)) return value.map((entry) => renameDeep(entry, renames));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renameDeep(entry, renames)]));
  return value;
}

/** The world every item of an instance belongs to. */
export interface WorldStamp {
  readonly clockId: string;
  readonly worldEpoch: number;
  /** `qa` or `guest` (docs/architecture.md §5); absent on demo worlds. */
  readonly world?: "qa" | "guest";
  readonly runId?: string;
  /** TTL in epoch seconds: QA worlds (48 h) and public guest worlds (hard expiry + 24 h). */
  readonly expiresAt?: number;
}

export interface InstanceOptions {
  readonly renames: Renames;
  readonly stamp: WorldStamp;
  readonly keys: WorldKeys;
  /** Tag appended to the provider ids of seeded messages, so no two worlds share one (GSI1). */
  readonly providerTag?: string;
  /** Real instant stamped on items the template has none for (the milestones of a clone). */
  readonly createdAt: string;
}

/** Fields a stamp writes (only those set: DynamoDB items never carry `undefined`). */
function stampFields(stamp: WorldStamp): Record<string, unknown> {
  return {
    ...(stamp.world === undefined ? {} : { world: stamp.world }),
    ...(stamp.runId === undefined ? {} : { runId: stamp.runId }),
    ...(stamp.expiresAt === undefined ? {} : { expiresAt: stamp.expiresAt }),
  };
}

/** `0100…-000000` → `0100…-000000-g03`; `<id@host>` → `<id-g03@host>`. */
function tagProviderIds(item: Record<string, unknown>, tag: string | undefined): Record<string, unknown> {
  if (tag === undefined || item.entity !== "Message") return item;
  const out = { ...item };
  if (typeof out.providerMessageId === "string") out.providerMessageId = `${out.providerMessageId}-${tag}`;
  if (typeof out.rfcMessageId === "string") out.rfcMessageId = out.rfcMessageId.replace(/^<([^@>]+)@/, `<$1-${tag}@`);
  return out;
}

async function derive(item: Record<string, unknown>, options: InstanceOptions, threads: Map<string, string>): Promise<Record<string, unknown>> {
  switch (item.entity) {
    case "Operation": {
      const threadTag = await computeThreadTag(options.keys.thread, { operationNumber: String(item.operationNumber), clockId: options.stamp.clockId, worldEpoch: options.stamp.worldEpoch });
      const address = threadAddress(String(item.operationNumber), threadTag);
      threads.set(String(item.operationId), address);
      return { ...item, worldEpoch: options.stamp.worldEpoch, threadTag, threadAddress: address };
    }
    case "Importer":
      return { ...item, phoneHash: phoneHash(options.keys.phoneHash, String(item.phoneE164)) };
    case "SupplierContact":
      return { ...item, emailHash: emailHash(options.keys.emailHash, String(item.email)) };
    default:
      return item;
  }
}

/** The `{threadAddress}` of a seeded email (`from`/`to`) replaced by its operation's thread address. */
export function fillThreadAddress(item: Record<string, unknown>, threads: ReadonlyMap<string, string>): Record<string, unknown> {
  if (item.entity !== "Message" && item.entity !== "MailboxMessage") return item;
  const address = threads.get(String(item.operationId));
  const fill = (value: unknown): unknown => {
    if (value !== THREAD_ADDRESS_PLACEHOLDER) return value;
    if (address === undefined) throw new RangeError(`no thread address for ${String(item.operationId)}`);
    return address;
  };
  return { ...item, from: fill(item.from), to: fill(item.to) };
}

/** A row of a world: its key, its entity and the entity's fields. */
export type WorldItem = Item & { readonly entity: string };

/** Places a complete entity at its key with its GSI attributes. */
export function keyedItem(item: Record<string, unknown>): WorldItem {
  const entity = item.entity as EntityName;
  const key = expectedKey(entity, item);
  if (key === undefined) throw new RangeError(`${String(item.entity)} is not a seedable entity`);
  return { ...item, ...key, ...expectedIndexAttributes(entity, item), entity: String(item.entity) };
}

/**
 * The instance items of a world's domain tables, in template order. Pass the `Operations` items in
 * the same call as the messages that cite their thread (or share `threads` across calls).
 */
export async function instantiateItems(items: readonly TemplateItem[], options: InstanceOptions, threads: Map<string, string> = new Map()): Promise<WorldItem[]> {
  const completed: Array<Record<string, unknown>> = [];
  for (const template of items) {
    const renamed = { createdAt: options.createdAt, updatedAt: options.createdAt, version: 1, synthetic: true, ...(renameDeep(template, options.renames) as Record<string, unknown>) };
    const stamped = tagProviderIds({ ...renamed, clockId: options.stamp.clockId, ...stampFields(options.stamp) }, options.providerTag);
    completed.push(await derive(stamped, options, threads));
  }
  return completed.map((item) => keyedItem(fillThreadAddress(withoutWorldlessClock(item), threads)));
}

// Firm-level rows (settings, brokers, checklists, the matrix) carry no clock in the seed: a world's
// stamp must not give them one.
const WORLDLESS = new Set(["FirmSettings", "Broker", "Checklist", "ResponsibilityMatrix"]);

function withoutWorldlessClock(item: Record<string, unknown>): Record<string, unknown> {
  if (!WORLDLESS.has(String(item.entity))) return item;
  const { clockId: _clockId, ...rest } = item;
  return rest;
}
