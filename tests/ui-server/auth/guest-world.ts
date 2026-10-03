// The guest worlds of the local UI server (ADR-0015 §4): the real `account.ensureWorld` and
// `account.world` (packages/bff/src/routers/guest-world.ts) over the in-memory `Runtime`, and
// `WorldJanitor` run in process for what the BFF hands it, as Lambda's asynchronous invocation would:
// `GUEST_CREATE` builds the world with the real world factory from the seed's `guest` template
// (scripts/seed/data/worlds/guest.json), binds the broker row to the account and readies the lease;
// `GUEST_DESTROY` is the real destroy. Memory is a map, the Scheduler records, S3 objects are in memory.
//
// Two switches exist only here, for specs that run side by side on this one server:
//
//   fullFor   accounts (`sub`) for which every public slot is taken: their slot writes lose the race,
//             so the real `ensureWorld` answers `CAPACITY` and creates nothing (FL-110, FL-132)
//   expire    destroys an account's world as the hourly sweep would at its TTL (FL-109)
//
// A long run of specs signs up more visitors than the 60 public slots: past `RECYCLE_AT` live public
// worlds, the oldest is destroyed the way its TTL would and its slot row removed, so the slot is free at
// once instead of after the 20-minute quarantine (a spec's world lives for seconds). The persona
// `guest` of the console specs gets the reserved world `firm-guest-01`, built the same way at start.
// Nothing here ships in a Lambda.
import { ConnectorError } from "@legajo/shared";
import { GUEST_SLOTS } from "@legajo/shared/guest-limits";
import type { MemoryStores } from "@legajo/bff/connector/index";
import { brokerKey, cognitoSubKey } from "@legajo/bff/connector/keys";
import type { Item, TableClient } from "@legajo/bff/connector/table-client";
import { createWorldJanitorHandler } from "@legajo/bff/handlers/world-janitor";
import { createLogger } from "@legajo/bff/lib/log";
import type { AccessDeps } from "@legajo/bff/signup/deps";
import type { WorldsDeps } from "@legajo/bff/worlds/deps";
import { createWorld } from "@legajo/bff/worlds/factory";
import { readAccountWorld, readSlot, slotKey } from "@legajo/bff/worlds/guest-slots";
import { destroyGuestWorld } from "@legajo/bff/worlds/guest-worlds";
import type { PurgeDeps } from "@legajo/bff/worlds/memory-purge";
import { worldsHarness } from "@legajo/bff/worlds/testing";
import { guestIdentity } from "@legajo/bff/worlds/world-ids";

/** Live public worlds past which the oldest one is destroyed, as its TTL would (60 slots, a margin kept free). */
export const RECYCLE_AT = 45;

export interface GuestWorldControl {
  /** Accounts (`sub`) for which the 60 public slots are taken: `ensureWorld` answers `CAPACITY`. */
  readonly fullFor: Set<string>;
  /** How long `WorldJanitor` takes to start a `GUEST_CREATE` after `ensureWorld`. */
  createDelayMs: number;
}

export interface GuestWorlds {
  readonly control: GuestWorldControl;
  /** The world factory's dependencies over the server's stores. */
  readonly deps: WorldsDeps;
  /** `Runtime` as the guest-world procedures see it (the `fullFor` switch). */
  wrapClient(client: TableClient): TableClient;
  /** `WorldJanitor` as the BFF invokes it: accepted at once, run after the delay. */
  invokeJanitor(payload: Readonly<Record<string, unknown>>): void;
  /** Resolves when every `WorldJanitor` event accepted so far has run. */
  settled(): Promise<void>;
  /** Destroys the world of `sub` as the hourly sweep would at its TTL. */
  expire(sub: string): Promise<boolean>;
  /** The reserved world of a persona, built from the `guest` template and bound to its `sub`. */
  seedReserved(firmId: string, sub: string): Promise<void>;
}

const log = createLogger({ level: "warn", bindings: { service: "ui-server-worlds" } });

function isSlotLease(table: string, item: Item): boolean {
  return table === "Runtime" && typeof item.PK === "string" && item.PK.startsWith("SLOT#GUEST#") && typeof item.sub === "string";
}

async function bindPersona(client: TableClient, firmId: string, sub: string, at: string): Promise<void> {
  const { brokerId } = guestIdentity(firmId);
  await client.update("Firms", brokerKey(firmId, brokerId), { set: { cognitoSub: sub, cognitoSubKey: cognitoSubKey(sub), role: "GUEST", active: true } }, at, { condition: { ifExists: true } });
}

/** Public slots leased and not released, oldest first. */
async function livePublicSlots(client: TableClient): Promise<Array<{ readonly firmId: string; readonly sub: string; readonly leasedAtReal: string }>> {
  const live: Array<{ firmId: string; sub: string; leasedAtReal: string }> = [];
  for (let nn = GUEST_SLOTS.public.first; nn <= GUEST_SLOTS.public.last; nn += 1) {
    const slot = await readSlot(client, nn);
    if (slot !== undefined && slot.releasedAtReal === undefined) live.push({ firmId: slot.firmId, sub: slot.sub, leasedAtReal: slot.leasedAtReal });
  }
  return live.sort((a, b) => Date.parse(a.leasedAtReal) - Date.parse(b.leasedAtReal));
}

export function createGuestWorlds(stores: MemoryStores, now: () => Date): GuestWorlds {
  const control: GuestWorldControl = { fullFor: new Set(), createDelayMs: 1_500 };
  const harness = worldsHarness({ stores });
  const deps: WorldsDeps = { ...harness.deps, now, log };
  const purge: PurgeDeps = { memory: harness.memory, data: stores.connector, log, now, sleep: () => Promise.resolve() };
  const janitor = createWorldJanitorHandler({
    purge,
    worlds: (continuePurge) => ({ ...deps, continuePurge }),
    sweep: () => {
      throw new Error("the UI server runs no GUEST_SWEEP");
    },
  });
  const queue: Promise<unknown>[] = [];

  async function recycle(): Promise<void> {
    const live = await livePublicSlots(stores.client);
    for (const oldest of live.slice(0, Math.max(0, live.length - RECYCLE_AT))) {
      await destroyGuestWorld({ firmId: oldest.firmId, reason: "TTL", sub: oldest.sub }, deps);
      const { nn } = guestIdentity(oldest.firmId);
      if (nn !== undefined) await stores.client.delete("Runtime", slotKey(nn));
    }
  }

  return {
    control,
    deps,
    wrapClient(client) {
      return {
        get: (table, key) => client.get(table, key),
        query: (table, spec) => client.query(table, spec),
        scan: (table, spec) => client.scan(table, spec),
        update: (table, key, spec, updatedAt, options) => client.update(table, key, spec, updatedAt, options),
        delete: (table, key, condition) => client.delete(table, key, condition),
        transact: (ops) => client.transact(ops),
        batchPut: (table, items) => client.batchPut(table, items),
        batchDelete: (table, keys) => client.batchDelete(table, keys),
        async put(table, item, condition) {
          if (isSlotLease(table, item) && control.fullFor.has(String(item.sub))) throw new ConnectorError("CONFLICT", "every public slot is taken (UI server switch)", table);
          return client.put(table, item, condition);
        },
      };
    },
    invokeJanitor(payload) {
      const run = new Promise((resolve) => setTimeout(resolve, control.createDelayMs))
        .then(() => janitor(payload))
        .then(() => (payload.kind === "GUEST_CREATE" ? recycle() : undefined))
        .catch((error: unknown) => log.error("ui_server.world_janitor_failed", { kind: String(payload.kind), error: error instanceof Error ? error.name : "unknown" }));
      queue.push(run);
    },
    async settled() {
      await Promise.all(queue);
    },
    async expire(sub) {
      await Promise.all(queue);
      const lease = await readAccountWorld(stores.client, sub);
      if (lease?.state !== "READY" || lease.firmId === undefined) return false;
      return (await destroyGuestWorld({ firmId: lease.firmId, reason: "TTL", sub }, deps)).destroyed;
    },
    async seedReserved(firmId, sub) {
      await createWorld({ kind: "GUEST", firmId }, deps);
      await bindPersona(stores.client, firmId, sub, now().toISOString());
    },
  };
}

/** The access dependencies with `WorldJanitor` run here and the `fullFor` switch on `Runtime`. */
export function withGuestWorlds(access: AccessDeps, worlds: GuestWorlds): AccessDeps {
  return {
    ...access,
    client: worlds.wrapClient(access.client),
    invoker: {
      async invoke(target, payload) {
        await access.invoker.invoke(target, payload);
        if (target === "WorldJanitor") worlds.invokeJanitor(payload);
      },
    },
  };
}
