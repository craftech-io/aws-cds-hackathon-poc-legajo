// The life of a guest world (ADR-0015 §4 and §5, docs/architecture.md §10):
//
//   ensureGuestWorld   `account.ensureWorld`: one `ensureWorld` per account counted (10 an hour), the
//                      account's lease `GUESTWORLD#<sub>` (a concurrent call gets CREATING or READY and
//                      leases nothing), the slot (the fixed one of a reserved account, from its
//                      `custom:firmId`; a public one 31–90 free or released ≥ 20 min ago), then
//                      `WorldJanitor {GUEST_CREATE}` asynchronously; answers in milliseconds. No slot:
//                      `CAPACITY`, the lease FAILED with that reason, metric `GuestWorldCapacity`
//   createGuestWorld   `GUEST_CREATE`: ignored unless the account's lease is still that `leaseId`; the
//                      world from `Seed/worlds/guest.json` (world factory), the broker row
//                      `Firms/BROKER#brk-guest-<nn>` bound to the `sub` with the `leaseId`, the name
//                      "Invitado" and no email, and the lease READY; on failure FAILED with the reason,
//                      the slot released and metric `GuestWorldFailed`
//   destroyGuestWorld  `destroyWorld`, the account's lease DESTROYED and, last, the slot released
//                      (`releasedAtReal`: not leased again for 20 minutes)
import { type EnsureWorldOutput } from "@legajo/shared/signup";
import { GUEST_SLOTS } from "@legajo/shared/guest-limits";
import { guestClockId } from "@legajo/shared";
import { countMetric } from "../channels/adapter";
import { brokerKey, cognitoSubKey } from "../connector/keys";
import type { TableClient } from "../connector/table-client";
import type { Logger } from "../lib/log";
import type { SignupCognito } from "../signup/cognito";
import type { AsyncInvoker } from "../signup/invoke";
import { RUNTIME_TABLE } from "../signup/counters";
import type { WorldsDeps } from "./deps";
import { destroyWorld } from "./destroy";
import { createWorld } from "./factory";
import { consumeWorldPreparation } from "./guest-quotas";
import { type AccountWorldLease, leaseAccountWorld, leasePublicSlot, markAccountWorld, readAccountWorld, readSlot, releaseSlot, slotKey } from "./guest-slots";
import { GUEST_TEST_FIRM, guestIdentity, guestSlotOf } from "./world-ids";

export const GUEST_WORLD_METRICS = { capacity: "GuestWorldCapacity", failed: "GuestWorldFailed" } as const;

/** Name of the broker row of every guest world (no email: the account's address never reaches a world). */
export const GUEST_BROKER_NAME = "Invitado";

export interface EnsureDeps {
  readonly client: TableClient;
  readonly cognito: Pick<SignupCognito, "getUser">;
  readonly invoker: AsyncInvoker;
  readonly now: () => Date;
  readonly newUlid: () => string;
  readonly log: Logger;
  readonly random?: () => number;
}

export interface GuestAccount {
  readonly sub: string;
  readonly username: string;
}

/** The fixed firm of a reserved account (`custom:firmId`, read with `AdminGetUser`), or `undefined` for a public one. */
async function reservedFirmOf(account: GuestAccount, deps: Pick<EnsureDeps, "cognito">): Promise<string | undefined> {
  const firmId = (await deps.cognito.getUser(account.username))?.firmId;
  if (firmId === GUEST_TEST_FIRM) return firmId;
  const nn = firmId === undefined ? undefined : guestSlotOf(firmId);
  return nn !== undefined && nn >= GUEST_SLOTS.reserved.first && nn <= GUEST_SLOTS.reserved.last ? firmId : undefined;
}

/** A reserved account's own slot: taken for this lease whatever it held before (no other account has that slot). */
async function leaseReservedSlot(client: TableClient, account: GuestAccount, firmId: string, leaseId: string, now: Date): Promise<void> {
  const nn = guestSlotOf(firmId);
  if (nn === undefined) return;
  const current = await readSlot(client, nn);
  const at = now.toISOString();
  const item = { ...slotKey(nn), entity: "GuestSlot", createdAt: at, updatedAt: at, version: (current?.version ?? 0) + 1, nn, sub: account.sub, firmId, clockId: guestClockId(firmId), leaseId, leasedAtReal: at, hardExpiresAtReal: "9999-12-31T23:59:59.000Z" };
  await client.put(RUNTIME_TABLE, item, current === undefined ? { ifNotExists: true } : { ifVersion: current.version });
}

function answerOf(lease: AccountWorldLease | undefined): EnsureWorldOutput {
  if (lease?.state === "READY" && lease.firmId !== undefined) return { state: "READY", firmId: lease.firmId, clockId: guestClockId(lease.firmId) };
  if (lease?.state === "FAILED" && lease.reason === "CAPACITY") return { state: "CAPACITY" };
  return { state: "CREATING" };
}

/** `account.ensureWorld` (see the header). Throws `QUOTA_EXCEEDED` past 10 calls an hour. */
export async function ensureGuestWorld(account: GuestAccount, deps: EnsureDeps): Promise<EnsureWorldOutput> {
  await consumeWorldPreparation({ client: deps.client, now: deps.now, log: deps.log }, account.sub);
  const now = deps.now();
  const leaseId = deps.newUlid();
  const taken = await leaseAccountWorld(deps.client, account.sub, leaseId, now);
  if (!taken.won) return answerOf(taken.current);

  const reserved = await reservedFirmOf(account, deps);
  let nn: number | undefined;
  let firmId: string;
  if (reserved !== undefined) {
    await leaseReservedSlot(deps.client, account, reserved, leaseId, now);
    firmId = reserved;
    nn = guestSlotOf(reserved);
  } else {
    const slot = await leasePublicSlot(deps.client, { sub: account.sub, leaseId, now, ...(deps.random === undefined ? {} : { random: deps.random }) });
    if (slot === undefined) {
      await markAccountWorld(deps.client, account.sub, leaseId, { state: "FAILED", reason: "CAPACITY" }, now);
      countMetric(deps.log, GUEST_WORLD_METRICS.capacity, {});
      return { state: "CAPACITY" };
    }
    firmId = slot.firmId;
    nn = slot.nn;
  }
  await markAccountWorld(deps.client, account.sub, leaseId, { state: "CREATING", firmId, ...(nn === undefined ? {} : { nn }) }, now);
  await deps.invoker.invoke("WorldJanitor", { kind: "GUEST_CREATE", sub: account.sub, leaseId, firmId, ...(nn === undefined ? {} : { nn }) });
  return { state: "CREATING" };
}

export interface GuestCreateInput {
  readonly sub: string;
  readonly leaseId: string;
  readonly firmId: string;
  readonly nn?: number;
}

export type GuestCreateOutcome = "READY" | "FAILED" | "STALE";

/** Binds the world's broker row to the account and its lease: from here the pre-token stamps `firmId` and `worldLease`. */
async function bindBroker(client: TableClient, input: GuestCreateInput, now: Date): Promise<void> {
  const { brokerId } = guestIdentity(input.firmId);
  await client.update(
    "Firms",
    brokerKey(input.firmId, brokerId),
    { set: { cognitoSub: input.sub, cognitoSubKey: cognitoSubKey(input.sub), leaseId: input.leaseId, name: GUEST_BROKER_NAME, role: "GUEST", active: true, email: null } },
    now.toISOString(),
    { condition: { ifExists: true } },
  );
}

/** `GUEST_CREATE` of `WorldJanitor` (see the header). */
export async function createGuestWorld(input: GuestCreateInput, deps: WorldsDeps): Promise<GuestCreateOutcome> {
  const { client } = deps;
  const lease = await readAccountWorld(client, input.sub);
  if (lease === undefined || lease.leaseId !== input.leaseId || lease.state !== "CREATING") return "STALE";
  const identity = guestIdentity(input.firmId);
  const slot = identity.nn === undefined ? undefined : await readSlot(client, identity.nn);
  if (identity.nn !== undefined && (slot?.leaseId !== input.leaseId || slot.releasedAtReal !== undefined)) return "STALE";
  try {
    await createWorld({ kind: "GUEST", firmId: input.firmId, ...(identity.guestKind === "PUBLIC" && slot !== undefined ? { hardExpiresAtReal: slot.hardExpiresAtReal } : {}) }, deps);
    await bindBroker(client, input, deps.now());
    await markAccountWorld(client, input.sub, input.leaseId, { state: "READY", firmId: input.firmId, ...(identity.nn === undefined ? {} : { nn: identity.nn }) }, deps.now());
    deps.log.info("guest_world.ready", { firmId: input.firmId });
    return "READY";
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    deps.log.error("guest_world.create_failed", { firmId: input.firmId, error: reason });
    countMetric(deps.log, GUEST_WORLD_METRICS.failed, { reason });
    await markAccountWorld(client, input.sub, input.leaseId, { state: "FAILED", reason: reason.slice(0, 64) }, deps.now());
    if (identity.nn !== undefined && identity.guestKind === "PUBLIC") await releaseSlot(client, identity.nn, input.leaseId, deps.now());
    return "FAILED";
  }
}

/** Destroys a guest firm's world, marks its account's lease DESTROYED and, last, releases its slot. */
export async function destroyGuestWorld(input: { readonly firmId: string; readonly reason: string; readonly sub?: string }, deps: WorldsDeps): Promise<{ readonly destroyed: boolean }> {
  const identity = guestIdentity(input.firmId);
  const slot = identity.nn === undefined ? undefined : await readSlot(deps.client, identity.nn);
  const owner = slot !== undefined && slot.releasedAtReal === undefined ? { sub: slot.sub, leaseId: slot.leaseId } : undefined;
  const result = await destroyWorld({ clockId: identity.clockId, reason: input.reason }, deps);
  const sub = owner?.sub ?? input.sub;
  if (sub !== undefined) {
    const lease = await readAccountWorld(deps.client, sub);
    if (lease !== undefined && lease.firmId === input.firmId && lease.state !== "DESTROYED") await markAccountWorld(deps.client, sub, lease.leaseId, { state: "DESTROYED" }, deps.now());
  }
  if (identity.nn !== undefined && owner !== undefined) await releaseSlot(deps.client, identity.nn, owner.leaseId, deps.now());
  return { destroyed: result.destroyed };
}

/** Every slot number of the guest worlds, reserved and public. */
export const ALL_SLOTS: readonly number[] = Array.from({ length: GUEST_SLOTS.public.last }, (_, index) => index + 1);

