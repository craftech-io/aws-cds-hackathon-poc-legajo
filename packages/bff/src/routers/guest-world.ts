// `account.ensureWorld` and `account.world` (ADR-0015 §4, docs/tool-catalog.md, FL-105, FL-110,
// FL-132): the world of a guest, on `guestBootstrapProcedure` (a verified GUEST token, with or without a
// firm yet). The account router (routers/account.ts) mounts both procedures under `account`.
//
//   ensureWorld  (mutation) one per visit of `/welcome`: the account's lease, a slot and
//                `WorldJanitor {GUEST_CREATE}`; answers CREATING, READY or CAPACITY in milliseconds and
//                never waits for the world (worlds/guest-worlds.ts); 10 calls an hour per account, then
//                `QUOTA_EXCEEDED`
//   world        (query, read only) the state the console polls every 2 s while CREATING: NONE, CREATING,
//                READY, EXPIRED, CAPACITY or FAILED, from the account's lease
import { accountWorldOf } from "./account";
import { ensureGuestWorld } from "../worlds/guest-worlds";
import { guestBootstrapProcedure } from "./trpc";

export const guestWorldProcedures = {
  ensureWorld: guestBootstrapProcedure.mutation(async ({ ctx }) => {
    const access = ctx.access();
    return ensureGuestWorld({ sub: ctx.guest.sub, username: ctx.guest.username }, { client: access.client, cognito: access.cognito, invoker: access.invoker, now: access.now, newUlid: access.newUlid, log: ctx.log });
  }),

  world: guestBootstrapProcedure.query(async ({ ctx }) => {
    const { state, firmId, clockId, since } = await accountWorldOf(ctx.access(), ctx.guest.sub);
    return { state, ...(firmId === undefined ? {} : { firmId }), ...(clockId === undefined ? {} : { clockId }), ...(since === undefined ? {} : { since }) };
  }),
};
