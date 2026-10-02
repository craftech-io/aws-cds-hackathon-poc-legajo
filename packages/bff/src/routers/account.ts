// `account` router (docs/tool-catalog.md, docs/architecture.md §10, FL-079, ADR-0015 §4): who the
// session is, the name of its firm and, for a guest, the state of its world, whether another session
// used the same guest world in the last 2 real hours (asked once per sign-in by the shell,
// packages/web/src/lib/console-api.ts) and its usage. The guest world keeps the last session that acted
// on it (`CLOCK#GUEST#<firmId>.lastSession`); a different `origin_jti` inside the window gets the fixed
// notice of docs/design-brief.md §7.1, which neither blocks nor offers a reset. The sign-in records
// this session as the last one, and every later call of the session keeps it fresh
// (guest-activity.ts, from `firmProcedure`).
//
//   session  staff: the firm gate of `firmProcedure`; a guest: also before its world exists or after
//            it is gone (the world's state instead of a 403), and a public guest's `Leads.lastLoginAt`
//   usage    a guest's quotas of its world and the global budget (`guestBootstrapProcedure`)
//
// `ensureWorld` and `world` belong to routers/guest-world.ts (WP-31, wave 4) on the same leases.
import { ConnectorError, type GuestKind, guestClockId } from "@legajo/shared";
import type { AccountWorldOutput, GuestWorldState } from "@legajo/shared/signup";
import type { GuestBootstrap, Principal } from "../auth/principal";
import { guestFromClaims, guestOfPrincipal, isSignInFresh } from "../auth/principal";
import type { Connector } from "../connector/index";
import type { Clock } from "../domain/world-state";
import { leadEmailHash } from "../lib/crypto";
import type { AccessDeps } from "../signup/deps";
import { readUsage } from "../worlds/guest-quotas";
import { isPublicGuestFirm, readAccountWorld, readSlot, worldStateOf } from "../worlds/guest-slots";
import { markGuestActivity, sessionIdOf } from "./guest-activity";
import { type Context, type FirmContext, enterFirm, guestBootstrapProcedure, isGuestWorldGone, publicProcedure, router } from "./trpc";

/** Another session within this many real milliseconds of its last action gets the notice. */
export const OTHER_SESSION_WINDOW_MS = 2 * 60 * 60_000;

export interface OtherSession {
  /** Last real instant the other session acted on the world. */
  readonly lastActiveAtReal: string;
  readonly minutesAgo: number;
}

/**
 * The notice for `sessionId` given the clock's last session, or `null`. When `sessionId` already is
 * the last session (its own write won, or this is a repeated check), the session it took over from counts.
 */
export function otherSessionOf(clock: Pick<Clock, "lastSession">, sessionId: string, realNow: Date): OtherSession | null {
  const last = clock.lastSession;
  const other = last?.originJti === sessionId ? last.previous : last;
  if (other === undefined || other.originJti === sessionId) return null;
  const elapsed = realNow.getTime() - Date.parse(other.lastActiveAtReal);
  if (elapsed < 0 || elapsed >= OTHER_SESSION_WINDOW_MS) return null;
  return { lastActiveAtReal: other.lastActiveAtReal, minutesAgo: Math.floor(elapsed / 60_000) };
}

/**
 * Reads the guest world, answers the notice and records this session as the last one. The notice
 * comes from the read; the write is best-effort: calls of the same sign-in race on the clock's version
 * (the shell's first batch, StrictMode's double effect), and a lost race must not cost the notice.
 * The session's next call records it again (guest-activity.ts).
 */
export async function touchGuestSession(data: Connector, principal: Principal, realNow: Date): Promise<{ worldReady: boolean; otherSession: OtherSession | null }> {
  const clockId = guestClockId(principal.firmId);
  const clock = await data.world.findClock(clockId);
  if (clock === undefined) return { worldReady: false, otherSession: null };
  const otherSession = otherSessionOf(clock, sessionIdOf(principal), realNow);
  try {
    await markGuestActivity(data, clock, principal, realNow, 0);
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
  }
  return { worldReady: true, otherSession };
}

/** RESERVED for `guest-01..NN` and `guest-test`; PUBLIC for a self-service account (no firm yet, or a public slot). */
export function guestKindOf(firmId: string | undefined): GuestKind {
  return firmId === undefined || isPublicGuestFirm(firmId) ? "PUBLIC" : "RESERVED";
}

/** The world as `account.world` says it (ADR-0015 §4), read from the account's lease. */
export async function accountWorldOf(access: Pick<AccessDeps, "client">, sub: string): Promise<AccountWorldOutput & { readonly expiresAtReal?: string }> {
  const lease = await readAccountWorld(access.client, sub);
  const state: GuestWorldState = worldStateOf(lease);
  const slot = state === "READY" && lease?.nn !== undefined ? await readSlot(access.client, lease.nn) : undefined;
  return {
    state,
    ...(lease?.firmId === undefined ? {} : { firmId: lease.firmId, clockId: guestClockId(lease.firmId) }),
    ...(lease === undefined ? {} : { since: lease.since }),
    ...(slot === undefined || slot.leaseId !== lease?.leaseId ? {} : { expiresAtReal: slot.hardExpiresAtReal }),
  };
}

/** `Leads.lastLoginAt` = the token's `auth_time` when it is later (a public guest's lead, keyed by its email). */
async function recordLogin(ctx: Context, guest: GuestBootstrap): Promise<void> {
  if (guest.email === undefined) return;
  try {
    const access = ctx.access();
    const at = new Date(guest.authTime * 1000).toISOString();
    await access.leads.touchLastLogin(leadEmailHash(access.keys.leadEmail, guest.email), at, access.now());
  } catch (error) {
    ctx.log.warn("account.last_login_not_recorded", { error: error instanceof Error ? error.name : "unknown" });
  }
}

function staffSession(firm: { firmId: string; name: string; kind: string } | null, principal: Principal, realNow: Date) {
  return {
    firm,
    firmId: principal.firmId,
    role: principal.role,
    isGuest: principal.isGuest,
    brokerId: principal.brokerId ?? null,
    recentLogin: isSignInFresh(principal, realNow),
    // Guests keep a permanent password and no TOTP (docs/architecture.md §10).
    canChangePassword: !principal.isGuest,
    canSetUpMfa: !principal.isGuest,
  };
}

async function firmSession(ctx: FirmContext) {
  const { principal } = ctx;
  const realNow = ctx.deps.wallClock();
  const firm = await ctx.deps.connector.firms.findFirm(principal.firmId);
  const base = staffSession(firm === undefined ? null : { firmId: firm.firmId, name: firm.name, kind: firm.kind }, principal, realNow);
  if (!principal.isGuest) return { ...base, worldReady: true, otherSession: null };
  const touched = await touchGuestSession(ctx.deps.connector, principal, realNow);
  return { ...base, ...touched, world: (touched.worldReady ? "READY" : "NONE") satisfies GuestWorldState, guestKind: guestKindOf(principal.firmId) };
}

/** A guest without a firm in its token, or whose world is gone: no firm, the world's state instead. */
async function bootstrapSession(ctx: Context, guest: GuestBootstrap) {
  const realNow = ctx.deps.wallClock();
  const world = await accountWorldOf(ctx.access(), guest.sub);
  return {
    firm: null,
    firmId: null,
    role: "GUEST" as const,
    isGuest: true,
    brokerId: null,
    recentLogin: isSignInFresh(guest, realNow),
    canChangePassword: false,
    canSetUpMfa: false,
    worldReady: false,
    otherSession: null,
    world: world.state,
    guestKind: guestKindOf(guest.firmId ?? world.firmId),
    ...(world.expiresAtReal === undefined ? {} : { worldExpiresAtReal: world.expiresAtReal }),
  };
}

export const accountRouter = router({
  session: publicProcedure.query(async ({ ctx, path }) => {
    const guest = ctx.claims !== null ? guestFromClaims(ctx.claims) : ctx.principal === null ? undefined : guestOfPrincipal(ctx.principal);
    if (guest === undefined || ctx.principal !== null) {
      try {
        const session = await firmSession(await enterFirm(ctx, path, () => Promise.resolve(undefined)));
        if (guest !== undefined) await recordLogin(ctx, guest);
        return session;
      } catch (error) {
        if (guest === undefined || !isGuestWorldGone(error)) throw error;
      }
    }
    await recordLogin(ctx, guest);
    return bootstrapSession(ctx, guest);
  }),

  usage: guestBootstrapProcedure.query(async ({ ctx }) => {
    const access = ctx.access();
    return readUsage(access.client, { sub: ctx.guest.sub, ...(ctx.guest.firmId === undefined ? {} : { clockId: guestClockId(ctx.guest.firmId) }) }, access.now());
  }),
});
