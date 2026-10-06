// `account` router (docs/tool-catalog.md, docs/architecture.md §10, FL-079, ADR-0015 §4): who the
// session is, the name of its firm and, for a guest, the state of its world and its usage. The guest
// world keeps the last session that acted on it (`CLOCK#GUEST#<firmId>.lastSession`) for the janitor's
// idle reset and public-world expiry: the sign-in records this session as the last one, and every later
// call of the session keeps it fresh (guest-activity.ts, from `firmProcedure`).
//
//   session  staff: the firm gate of `firmProcedure`; a guest: also before its world exists or after
//            it is gone (the world's state instead of a 403), and a public guest's `Leads.lastLoginAt`
//   usage    a guest's quotas of its world and the global budget (`guestBootstrapProcedure`)
//
//   preferences / setLanguage   the account's own language (`Runtime/ACCOUNT#<sub>`), per Cognito `sub`,
//            for staff and guests (`accountProcedure`); it lives outside every world, so a guest world that
//            is reset, destroyed or recreated keeps it
//
// `ensureWorld` and `world` belong to routers/guest-world.ts (WP-31), mounted under `account` with these
// (routers/index.ts), on the same leases.
import { ConnectorError, type GuestKind, Language, guestClockId } from "@legajo/shared";
import type { AccountWorldOutput, GuestWorldState } from "@legajo/shared/signup";
import { z } from "zod";
import type { GuestBootstrap, Principal } from "../auth/principal";
import { guestFromClaims, guestOfPrincipal, isSignInFresh } from "../auth/principal";
import type { Connector } from "../connector/index";
import { leadEmailHash } from "../lib/crypto";
import type { AccessDeps } from "../signup/deps";
import { readUsage } from "../worlds/guest-quotas";
import { isPublicGuestFirm, readSlot, worldStateOf } from "../worlds/guest-slots";
import { liveAccountWorld } from "../worlds/guest-worlds";
import { markGuestActivity } from "./guest-activity";
import { type Context, type FirmContext, accountProcedure, enterFirm, guestBootstrapProcedure, isGuestWorldGone, publicProcedure, router } from "./trpc";

/**
 * Reads the guest world and records this session as the last one. The write is best-effort: calls of
 * the same sign-in race on the clock's version (the shell's first batch, StrictMode's double effect),
 * and the session's next call records it again (guest-activity.ts).
 */
export async function touchGuestSession(data: Connector, principal: Principal, realNow: Date): Promise<{ worldReady: boolean }> {
  const clock = await data.world.findClock(guestClockId(principal.firmId));
  if (clock === undefined) return { worldReady: false };
  try {
    await markGuestActivity(data, clock, principal, realNow, 0);
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
  }
  return { worldReady: true };
}

/** RESERVED for `guest-01..NN` and `guest-test`; PUBLIC for a self-service account (no firm yet, or a public slot). */
export function guestKindOf(firmId: string | undefined): GuestKind {
  return firmId === undefined || isPublicGuestFirm(firmId) ? "PUBLIC" : "RESERVED";
}

/** The world as `account.world` says it (ADR-0015 §4), read from the account's lease. */
export async function accountWorldOf(access: Pick<AccessDeps, "client" | "now">, sub: string): Promise<AccountWorldOutput & { readonly expiresAtReal?: string }> {
  const lease = await liveAccountWorld(access.client, sub, access.now());
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
  if (!principal.isGuest) return { ...base, worldReady: true };
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
    world: world.state,
    guestKind: guestKindOf(guest.firmId ?? world.firmId),
    ...(world.expiresAtReal === undefined ? {} : { worldExpiresAtReal: world.expiresAtReal }),
  };
}

/** `setLanguage` input: only the two languages of the console, nothing else travels. */
export const SetLanguageInput = z.object({ language: Language }).strict();

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

  /** The language the account chose, or `null` while it never did (the browser decides then). */
  preferences: accountProcedure.query(async ({ ctx }) => {
    const row = await ctx.deps.connector.runtime.getAccountPreferences(ctx.sub);
    return { language: row?.language ?? null };
  }),

  setLanguage: accountProcedure.input(SetLanguageInput).mutation(async ({ ctx, input }) => {
    const row = await ctx.deps.connector.runtime.setAccountLanguage(ctx.sub, input.language);
    ctx.log.info("account.language_set", { language: row.language });
    return { language: row.language };
  }),

  usage: guestBootstrapProcedure.query(async ({ ctx }) => {
    const access = ctx.access();
    return readUsage(access.client, { sub: ctx.guest.sub, ...(ctx.guest.firmId === undefined ? {} : { clockId: guestClockId(ctx.guest.firmId) }) }, access.now());
  }),
});
