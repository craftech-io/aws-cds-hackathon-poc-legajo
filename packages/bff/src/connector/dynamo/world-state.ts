// World state in `Runtime` (ADR-0007, docs/architecture.md §7-§8): clocks (never deleted by a
// reset), epochs from a counter that is never deleted and never goes back, the in-flight sets of
// operations and worlds (idempotent `ADD`/`DELETE` on string sets), pending mails and scans, leases
// and tombstones. This is what `op.settle` and the `WORLD_BUSY` gate read.
import { ConnectorError, parseClockId } from "@legajo/shared";
import { QA_WORLD_TTL_SECONDS, epochSecondsAfter } from "../../domain/common";
import { PENDING_STALE_SECONDS, RUNTIME_TTL_SECONDS } from "../../domain/runtime";
import { Clock, Lease, MailPending, OpState, ScanPending, Tombstone, WorldState } from "../../domain/world-state";
import type { TableName } from "../../lib/resource";
import { MAIL_PENDING_PREFIX, SCAN_PENDING_PREFIX, clockKey, epochCounterKey, leaseKey, mailPendingKey, opStateKey, pendingPartition, scanPendingKey, tombstoneKey, worldStateKey } from "../keys";
import { CLEARABLE_CLOCK_FIELDS, type InFlightEvent, type WorldPort } from "../ports-runtime";
import type { TransactOp, UpdateSpec } from "../table-client";
import { buildRow, checkPatch, createRow, creationDefaults, defined, nowIso, optionalEntity, parseEntities, requireEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "Runtime";

/** `<operationId>#<eventId>`: the element of `WORLDSTATE#<clockId>.inFlight`. */
export const worldInFlightId = (event: InFlightEvent): string => `${event.operationId}#${event.eventId}`;

export function worldStateRepo(ctx: RepoContext): WorldPort {
  const { client } = ctx;

  const isConflict = (error: unknown): boolean => error instanceof ConnectorError && error.code === "CONFLICT";

  function inFlightOps(event: InFlightEvent, change: "add" | "delete", set?: Record<string, unknown>): TransactOp[] {
    const updatedAt = nowIso(ctx);
    const members = (element: string): UpdateSpec => (change === "add" ? { addToSet: { inFlight: [element] } } : { deleteFromSet: { inFlight: [element] } });
    const opDefaults = creationDefaults(ctx, "OpState", { operationId: event.operationId, clockId: event.clockId });
    const worldDefaults = creationDefaults(ctx, "WorldState", { clockId: event.clockId });
    return [
      { op: "update", table: TABLE, key: opStateKey(event.operationId), spec: { ...members(event.eventId), setIfAbsent: opDefaults, ...(set ? { set } : {}) }, updatedAt, options: { upsert: true } },
      { op: "update", table: TABLE, key: worldStateKey(event.clockId), spec: { ...members(worldInFlightId(event)), setIfAbsent: worldDefaults }, updatedAt, options: { upsert: true } },
    ];
  }

  function pendingTimes(now: Date): { staleAtReal: string; expiresAt: number } {
    return { staleAtReal: new Date(now.getTime() + PENDING_STALE_SECONDS * 1000).toISOString(), expiresAt: epochSecondsAfter(now, RUNTIME_TTL_SECONDS.pending) };
  }

  return {
    async getClock(clockId) {
      return requireEntity(Clock, "Clock", await client.get(TABLE, clockKey(clockId)), TABLE, `clock ${clockId}`);
    },

    async findClock(clockId) {
      return optionalEntity(Clock, "Clock", await client.get(TABLE, clockKey(clockId)), TABLE);
    },

    async createClock(clock) {
      return createRow(ctx, TABLE, Clock, "Clock", clockKey(clock.clockId), clock);
    },

    async updateClock(clockId, patch, expectedVersion) {
      const cleared = Object.entries(patch).filter(([, value]) => value === null).map(([name]) => name);
      const unclearable = cleared.filter((name) => !(CLEARABLE_CLOCK_FIELDS as readonly string[]).includes(name));
      if (unclearable.length > 0) throw new ConnectorError("VALIDATION", `clock fields ${unclearable.join(", ")} cannot be cleared`, TABLE);
      checkPatch(Clock, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null)), TABLE, `clock ${clockId}`);
      const key = clockKey(clockId);
      const clock = requireEntity(Clock, "Clock", await client.get(TABLE, key), TABLE, `clock ${clockId}`);
      if (expectedVersion !== undefined && expectedVersion !== clock.version) throw new ConnectorError("CONFLICT", `clock ${clockId} changed`, TABLE);
      return updateRow(ctx, TABLE, Clock, "Clock", key, { set: { ...patch } }, { condition: { ifVersion: clock.version } });
    },

    // The counter survives resets and `world.destroy`; only the ids of `qa-*` clocks, which never
    // repeat, let it expire.
    async nextEpoch(clockId) {
      const ttl = parseClockId(clockId)?.scope === "QA" ? { expiresAt: epochSecondsAfter(ctx.now(), QA_WORLD_TTL_SECONDS) } : {};
      const row = await client.update(TABLE, epochCounterKey(clockId), { add: { value: 1 }, setIfAbsent: { entity: "Counter", name: `EPOCH#${clockId}`, createdAt: nowIso(ctx), synthetic: false, ...ttl } }, nowIso(ctx), { upsert: true });
      if (typeof row.value !== "number") throw new ConnectorError("VALIDATION", `epoch counter of ${clockId} is not numeric`, TABLE);
      return row.value;
    },

    async currentEpoch(clockId) {
      const row = await client.get(TABLE, epochCounterKey(clockId));
      return typeof row?.value === "number" ? row.value : undefined;
    },

    async markInFlight(event) {
      await client.transact(inFlightOps(event, "add"));
    },

    async settleInFlight(event) {
      await client.transact(inFlightOps(event, "delete"));
    },

    async recordProcessError(event) {
      await client.transact(inFlightOps(event, "delete", { processError: { eventId: event.eventId, type: event.type, atReal: event.atReal } }));
    },

    async clearProcessError(operationId) {
      try {
        await client.update(TABLE, opStateKey(operationId), { set: { processError: null } }, nowIso(ctx));
      } catch (error) {
        if (!(error instanceof ConnectorError) || error.code !== "NOT_FOUND") throw error;
      }
    },

    async getOpState(operationId) {
      return optionalEntity(OpState, "OpState", await client.get(TABLE, opStateKey(operationId)), TABLE);
    },

    async getWorldState(clockId) {
      return optionalEntity(WorldState, "WorldState", await client.get(TABLE, worldStateKey(clockId)), TABLE);
    },

    async putMailPending(pending) {
      const times = pendingTimes(ctx.now());
      return createRow(ctx, TABLE, MailPending, "MailPending", mailPendingKey(pending.clockId, pending.mailId), { ...times, ...defined(pending) });
    },

    async getMailPending(clockId, mailId) {
      return optionalEntity(MailPending, "MailPending", await client.get(TABLE, mailPendingKey(clockId, mailId)), TABLE);
    },

    // Only the mail that pending item was written for closes it (same `from`).
    async closeMailPending(input) {
      try {
        await client.delete(TABLE, mailPendingKey(input.clockId, input.mailId), { ifExists: true, equals: { from: input.from } });
        return true;
      } catch (error) {
        if (isConflict(error)) return false;
        throw error;
      }
    },

    async putScanPending(pending) {
      const times = pendingTimes(ctx.now());
      return createRow(ctx, TABLE, ScanPending, "ScanPending", scanPendingKey(pending.clockId, pending.scanKey), { ...times, ...defined(pending) });
    },

    async closeScanPending(clockId, scanKey) {
      try {
        await client.delete(TABLE, scanPendingKey(clockId, scanKey), { ifExists: true });
        return true;
      } catch (error) {
        if (isConflict(error)) return false;
        throw error;
      }
    },

    async listPending(clockId) {
      const [mails, scans] = await Promise.all([
        client.query(TABLE, { hashValue: pendingPartition(clockId), range: { prefix: MAIL_PENDING_PREFIX } }),
        client.query(TABLE, { hashValue: pendingPartition(clockId), range: { prefix: SCAN_PENDING_PREFIX } }),
      ]);
      return { mails: parseEntities(MailPending, "MailPending", mails, TABLE), scans: parseEntities(ScanPending, "ScanPending", scans, TABLE) };
    },

    // A lapsed lease (its `expiresAt` passed, TTL deletion is lazy) can be taken over; a live one never.
    async acquireLease(input) {
      const now = ctx.now();
      const { item } = buildRow(ctx, TABLE, Lease, "Lease", leaseKey(input.kind, input.value), { kind: input.kind, value: input.value, holder: input.holder, acquiredAtReal: input.atReal }, { ttlSeconds: RUNTIME_TTL_SECONDS.lease });
      try {
        await client.put(TABLE, item, { ifAbsentOrExpiredAt: Math.floor(now.getTime() / 1000) });
        return true;
      } catch (error) {
        if (isConflict(error)) return false;
        throw error;
      }
    },

    async releaseLease(input) {
      try {
        await client.delete(TABLE, leaseKey(input.kind, input.value), { ifExists: true, equals: { holder: input.holder } });
        return true;
      } catch (error) {
        if (isConflict(error)) return false;
        throw error;
      }
    },

    async getLease(kind, value) {
      return optionalEntity(Lease, "Lease", await client.get(TABLE, leaseKey(kind, value)), TABLE);
    },

    async putTombstone(input) {
      const key = tombstoneKey(input.clockId, input.worldEpoch);
      try {
        return await createRow(ctx, TABLE, Tombstone, "Tombstone", key, input, { ttlSeconds: RUNTIME_TTL_SECONDS.tombstone });
      } catch (error) {
        if (!isConflict(error)) throw error;
        return requireEntity(Tombstone, "Tombstone", await client.get(TABLE, key), TABLE, `tombstone ${input.clockId}#${input.worldEpoch}`);
      }
    },

    async isTombstoned(clockId, worldEpoch) {
      return (await client.get(TABLE, tombstoneKey(clockId, worldEpoch))) !== undefined;
    },
  };
}
