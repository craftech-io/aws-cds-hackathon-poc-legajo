// The two leases of a guest world (ADR-0015 §4), as conditional writes on `Runtime`:
//
//   GUESTWORLD#<sub>   one per account: taken before touching a slot, so one account creates one world
//                      however many tabs or retries call `account.ensureWorld` at once
//   SLOT#GUEST#<nn>    one of the 60 public slots (31–90), tried from a random one: free, or released at
//                      least 20 minutes ago (the life of a token plus margin), with the same `leaseId`
//
// Every take is "read, then write conditional on what was read" (absent, or the same `version`), so
// of two concurrent callers exactly one wins and the other reads the winner's state. WP-31 builds
// `account.ensureWorld`, `GUEST_CREATE` and `destroyWorld` on these; this module never creates a world.
import { z } from "zod";
import { ConnectorError, type FirmId, guestClockId } from "@legajo/shared";
import { GUEST_SLOTS, GUEST_WORLD_CREATING_STALE_MINUTES, GUEST_WORLD_MAX_AGE_HOURS, SLOT_RELEASE_COOLDOWN_MINUTES } from "@legajo/shared/guest-limits";
import type { GuestWorldState } from "@legajo/shared/signup";
import type { Item, Key, TableClient } from "../connector/index";
import { RUNTIME_TABLE } from "../signup/counters";

const Instant = z.string().min(20).max(40);

export const AccountWorldLease = z.object({
  sub: z.string().min(1).max(128),
  leaseId: z.string().min(1).max(64),
  state: z.enum(["CREATING", "READY", "FAILED", "DESTROYED"]),
  since: Instant,
  nn: z.number().int().min(1).max(99).optional(),
  firmId: z.string().optional(),
  /** Why a lease FAILED: `CAPACITY` (no public slot) or what the creation said. */
  reason: z.string().max(64).optional(),
  version: z.number().int().min(1),
});
export type AccountWorldLease = z.infer<typeof AccountWorldLease>;

export const SlotLease = z.object({
  nn: z.number().int().min(1).max(99),
  sub: z.string().min(1).max(128),
  firmId: z.string(),
  clockId: z.string(),
  leaseId: z.string().min(1).max(64),
  leasedAtReal: Instant,
  hardExpiresAtReal: Instant,
  releasedAtReal: Instant.optional(),
  version: z.number().int().min(1),
});
export type SlotLease = z.infer<typeof SlotLease>;

export function accountWorldKey(sub: string): Key {
  return { PK: `GUESTWORLD#${sub}`, SK: "META" };
}

const pad = (nn: number): string => String(nn).padStart(2, "0");

export function slotKey(nn: number): Key {
  return { PK: `SLOT#GUEST#${pad(nn)}`, SK: "META" };
}

/** `firm-guest-<nn>`: the firm of a slot, also the block of fictitious phones and mailboxes (ADR-0015 §4). */
export function guestFirmOf(nn: number): FirmId {
  return `firm-guest-${pad(nn)}`;
}

/** The slot number of a guest firm, or `undefined` for `firm-guest-test` and anything else. */
export function slotOfFirm(firmId: string): number | undefined {
  const match = /^firm-guest-(\d{2})$/.exec(firmId);
  return match === null ? undefined : Number(match[1]);
}

/** Public worlds count against the global budget and expire; reserved ones (01–30, `guest-test`) do not. */
export function isPublicGuestFirm(firmId: string): boolean {
  const nn = slotOfFirm(firmId);
  return nn !== undefined && nn >= GUEST_SLOTS.public.first && nn <= GUEST_SLOTS.public.last;
}

function isConflict(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === "CONFLICT";
}

function parsed<T>(schema: z.ZodType<T>, item: Item | undefined): T | undefined {
  if (item === undefined) return undefined;
  const result = schema.safeParse(item);
  if (!result.success) throw new ConnectorError("VALIDATION", "a guest lease row does not match its schema", "Runtime");
  return result.data;
}

export async function readAccountWorld(client: TableClient, sub: string): Promise<AccountWorldLease | undefined> {
  return parsed(AccountWorldLease, await client.get(RUNTIME_TABLE, accountWorldKey(sub)));
}

export async function readSlot(client: TableClient, nn: number): Promise<SlotLease | undefined> {
  return parsed(SlotLease, await client.get(RUNTIME_TABLE, slotKey(nn)));
}

/** `account.world` of a lease (ADR-0015 §4): the states the console knows, and only those. */
export function worldStateOf(lease: Pick<AccountWorldLease, "state" | "reason"> | undefined): GuestWorldState {
  if (lease === undefined) return "NONE";
  if (lease.state === "DESTROYED") return "EXPIRED";
  if (lease.state === "FAILED") return lease.reason === "CAPACITY" ? "CAPACITY" : "FAILED";
  return lease.state;
}

/** A lease the next `ensureWorld` may take over: none, a destroyed or failed world, or a creation that fell over. */
export function isTakeable(lease: AccountWorldLease | undefined, now: Date): boolean {
  if (lease === undefined || lease.state === "DESTROYED" || lease.state === "FAILED") return true;
  return lease.state === "CREATING" && now.getTime() - Date.parse(lease.since) > GUEST_WORLD_CREATING_STALE_MINUTES * 60_000;
}

export type AccountLeaseResult = { readonly won: true; readonly lease: AccountWorldLease } | { readonly won: false; readonly current: AccountWorldLease | undefined };

/** Takes `GUESTWORLD#<sub>` for a new world with `leaseId`; a concurrent caller loses and reads the winner. */
export async function leaseAccountWorld(client: TableClient, sub: string, leaseId: string, now: Date): Promise<AccountLeaseResult> {
  const current = await readAccountWorld(client, sub);
  if (!isTakeable(current, now)) return { won: false, current };
  const item = { ...accountWorldKey(sub), entity: "GuestWorldLease", createdAt: now.toISOString(), updatedAt: now.toISOString(), version: (current?.version ?? 0) + 1, sub, leaseId, state: "CREATING", since: now.toISOString() };
  try {
    await client.put(RUNTIME_TABLE, item, current === undefined ? { ifNotExists: true } : { ifVersion: current.version });
    return { won: true, lease: AccountWorldLease.parse(item) };
  } catch (error) {
    if (!isConflict(error)) throw error;
    return { won: false, current: await readAccountWorld(client, sub) };
  }
}

/** Moves the account's lease, only while it is still `leaseId` (a stale `GUEST_CREATE` does nothing). */
export async function markAccountWorld(
  client: TableClient,
  sub: string,
  leaseId: string,
  patch: { readonly state: AccountWorldLease["state"]; readonly nn?: number; readonly firmId?: string; readonly reason?: string },
  now: Date,
): Promise<boolean> {
  try {
    await client.update(RUNTIME_TABLE, accountWorldKey(sub), { set: { ...patch, since: now.toISOString() } }, now.toISOString(), { condition: { equals: { leaseId } } });
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}

function slotFree(slot: SlotLease | undefined, now: Date): boolean {
  if (slot === undefined) return true;
  return slot.releasedAtReal !== undefined && now.getTime() - Date.parse(slot.releasedAtReal) >= SLOT_RELEASE_COOLDOWN_MINUTES * 60_000;
}

const PUBLIC_SLOTS = Array.from({ length: GUEST_SLOTS.public.last - GUEST_SLOTS.public.first + 1 }, (_, index) => GUEST_SLOTS.public.first + index);

/**
 * Leases a public slot for `sub` with `leaseId`, trying every one from a random start; `undefined` when
 * all 60 are taken or released less than 20 minutes ago (`CAPACITY`).
 */
export async function leasePublicSlot(client: TableClient, input: { readonly sub: string; readonly leaseId: string; readonly now: Date; readonly random?: () => number }): Promise<SlotLease | undefined> {
  const { now } = input;
  const start = Math.floor((input.random ?? Math.random)() * PUBLIC_SLOTS.length) % PUBLIC_SLOTS.length;
  for (let offset = 0; offset < PUBLIC_SLOTS.length; offset += 1) {
    const nn = PUBLIC_SLOTS[(start + offset) % PUBLIC_SLOTS.length] ?? GUEST_SLOTS.public.first;
    const current = await readSlot(client, nn);
    if (!slotFree(current, now)) continue;
    const firmId = guestFirmOf(nn);
    const item = {
      ...slotKey(nn),
      entity: "GuestSlot",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      version: (current?.version ?? 0) + 1,
      nn,
      sub: input.sub,
      firmId,
      clockId: guestClockId(firmId),
      leaseId: input.leaseId,
      leasedAtReal: now.toISOString(),
      hardExpiresAtReal: new Date(now.getTime() + GUEST_WORLD_MAX_AGE_HOURS * 3_600_000).toISOString(),
    };
    try {
      await client.put(RUNTIME_TABLE, item, current === undefined ? { ifNotExists: true } : { ifVersion: current.version });
      return SlotLease.parse(item);
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  return undefined;
}

/** Releases slot `nn` (last step of `destroyWorld`), only while it is still leased with `leaseId`. */
export async function releaseSlot(client: TableClient, nn: number, leaseId: string, now: Date): Promise<boolean> {
  try {
    await client.update(RUNTIME_TABLE, slotKey(nn), { set: { releasedAtReal: now.toISOString() } }, now.toISOString(), { condition: { equals: { leaseId }, absent: ["releasedAtReal"] } });
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}
