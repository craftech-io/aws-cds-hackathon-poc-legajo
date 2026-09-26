// Storage port of the platform mock and its in-memory adapter (the DynamoDB one is dynamo-store.ts).
// A change is one atomic step: the operation's `META` moves to `version + 1` only if nobody changed
// it since it was read, together with the `EVT#` row of the event it produces. The event row keeps
// the request's `Idempotency-Key` and a hash of its body, which is how a retry finds what it already
// did. Failures are `ConnectorError`s of @legajo/shared: CONFLICT when the version moved, VALIDATION
// when a stored row does not match its schema, THROTTLED/UNAVAILABLE/TIMEOUT when the table is down.
import { z } from "zod";
import { ConnectorError, IsoInstant } from "@legajo/shared";
import { IdempotencyKey } from "./api";
import { PlatformEventId, PlatformFeedEvent } from "./events";
import {
  PLATFORM_EVENT_SK_PREFIX,
  PLATFORM_META_SK,
  PlatformItemMeta,
  PlatformOperationItem,
  platformEventSk,
  platformPk,
  worldAttributesOf,
  type CustomsState,
  type ZonedInstant,
} from "./schema";

export const PLATFORM_TABLE = "Platform";

/** One published event in the log of its operation (`EVT#<createdAt>#<eventId>`). */
export const PlatformEventItem = z
  .object({
    PK: z.string().startsWith("POP#"),
    SK: z.string().startsWith(PLATFORM_EVENT_SK_PREFIX),
    entity: z.literal("PlatformEvent"),
    eventId: PlatformEventId,
    event: PlatformFeedEvent,
    idempotencyKey: IdempotencyKey,
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    ...PlatformItemMeta.shape,
  })
  .strict()
  .refine((item) => item.event.detail.eventId === item.eventId, { message: "eventId differs from the event detail", path: ["eventId"] });
export type PlatformEventItem = z.infer<typeof PlatformEventItem>;

/** The only fields a change moves. */
export interface PlatformOperationPatch {
  readonly eta?: ZonedInstant;
  readonly customs?: CustomsState;
}

export interface PlatformChange {
  /** The row as it was read; the write is conditional on its `version`. */
  readonly operation: PlatformOperationItem;
  readonly patch: PlatformOperationPatch;
  readonly eventItem: PlatformEventItem;
  readonly now: Date;
}

export interface PlatformStore {
  getOperation(firmId: string, operationNumber: string): Promise<PlatformOperationItem | undefined>;
  /** The event an earlier request with this key produced for this operation, if any. */
  findEvent(firmId: string, operationNumber: string, idempotencyKey: string): Promise<PlatformEventItem | undefined>;
  /** Applies `patch` and writes `eventItem` atomically; ConnectorError CONFLICT when the version moved. */
  commit(change: PlatformChange): Promise<void>;
}

export interface EventItemInput {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly now: Date;
}

/** The event row of a change; it inherits the world attributes of its operation. */
export function toPlatformEventItem(operation: PlatformOperationItem, event: PlatformFeedEvent, input: EventItemInput): PlatformEventItem {
  const at = IsoInstant.parse(input.now.toISOString());
  return PlatformEventItem.parse({
    PK: operation.PK,
    SK: platformEventSk(at, event.detail.eventId),
    entity: "PlatformEvent",
    eventId: event.detail.eventId,
    event,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    createdAt: at,
    updatedAt: at,
    version: 1,
    ...worldAttributesOf(operation),
  });
}

/** The row after a change: the patched fields, `version + 1` and the new `updatedAt`. */
export function applyPatch(operation: PlatformOperationItem, patch: PlatformOperationPatch, now: Date): PlatformOperationItem {
  return PlatformOperationItem.parse({ ...operation, ...patch, version: operation.version + 1, updatedAt: now.toISOString() });
}

/** Parses a stored row; a row that does not match its schema is a VALIDATION failure, never data. */
export function parseStored<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ConnectorError("VALIDATION", `stored ${what} does not match its schema`, PLATFORM_TABLE, { cause: parsed.error });
  return parsed.data;
}

// ---- In-memory adapter ---------------------------------------------------------------------------

export interface MemoryPlatformStore extends PlatformStore {
  /** Writes a `META` row as the world factory does (tests, the local flows and the UI server). */
  putOperation(item: PlatformOperationItem): void;
  /** Every stored row, `META` and `EVT#`, sorted by key. */
  items(): Array<PlatformOperationItem | PlatformEventItem>;
}

function keyOf(pk: string, sk: string): string {
  return `${pk}\u0000${sk}`;
}

export function createMemoryPlatformStore(initial: readonly PlatformOperationItem[] = []): MemoryPlatformStore {
  const rows = new Map<string, PlatformOperationItem | PlatformEventItem>();

  const putOperation = (item: PlatformOperationItem): void => {
    const parsed = PlatformOperationItem.parse(item);
    rows.set(keyOf(parsed.PK, parsed.SK), structuredClone(parsed));
  };
  initial.forEach(putOperation);

  const eventsOf = (pk: string): PlatformEventItem[] =>
    [...rows.values()].filter((row): row is PlatformEventItem => row.PK === pk && row.entity === "PlatformEvent");

  return {
    putOperation,
    items: () => [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => structuredClone(row)),

    async getOperation(firmId, operationNumber) {
      const row = rows.get(keyOf(platformPk(firmId, operationNumber), PLATFORM_META_SK));
      return row === undefined ? undefined : parseStored(PlatformOperationItem, structuredClone(row), "operation");
    },

    async findEvent(firmId, operationNumber, idempotencyKey) {
      const found = eventsOf(platformPk(firmId, operationNumber)).find((row) => row.idempotencyKey === idempotencyKey);
      return found === undefined ? undefined : parseStored(PlatformEventItem, structuredClone(found), "event");
    },

    async commit(change) {
      const metaKey = keyOf(change.operation.PK, PLATFORM_META_SK);
      const current = rows.get(metaKey);
      if (current === undefined || current.version !== change.operation.version) {
        throw new ConnectorError("CONFLICT", "the operation changed since it was read", PLATFORM_TABLE);
      }
      const eventKey = keyOf(change.eventItem.PK, change.eventItem.SK);
      if (rows.has(eventKey)) throw new ConnectorError("CONFLICT", "the event row already exists", PLATFORM_TABLE);
      const next = applyPatch(change.operation, change.patch, change.now);
      rows.set(metaKey, structuredClone(next));
      rows.set(eventKey, structuredClone(PlatformEventItem.parse(change.eventItem)));
    },
  };
}
