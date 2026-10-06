// The account's language (`account.preferences`, `account.setLanguage`, FL-133): one row per Cognito
// `sub` in `Runtime` (`ACCOUNT#<sub>`/`PREFS`), for staff and for guests, with or without a world. It is
// never part of a world (no clock, no TTL), so a reset, a destruction or a new world keeps it, and
// `leads:delete` removes it with the account. Nothing but `"es" | "en"` is accepted.
import { beforeEach, describe, expect, it } from "vitest";
import { seedBrokers } from "../auth/testing";
import type { MemoryStores } from "../connector/index";
import { accountPreferencesKey } from "../connector/keys";
import { memoryStores } from "../connector/testing";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { type Bff, bffFor, call, trpcEvent } from "../signup/testing-http";
import { DIEGO, MARTINA, SUBS, consoleWorld } from "./testing";

const GUEST_SUB = "5a1d0c3e-0000-4000-8000-0000000000bb";
const NOW = new Date("2026-10-14T13:30:00.000Z");

describe("[FL-133] account.preferences and account.setLanguage for staff", () => {
  it("answers no language until the account chooses one, then keeps it per user", async () => {
    const world = await consoleWorld();
    expect(await world.caller(DIEGO).account.preferences()).toEqual({ language: null });
    expect(await world.caller(DIEGO).account.setLanguage({ language: "en" })).toEqual({ language: "en" });
    expect(await world.caller(DIEGO).account.preferences()).toEqual({ language: "en" });
    // Another user of the same firm has its own preference.
    expect(await world.caller(MARTINA).account.preferences()).toEqual({ language: null });
    await world.caller(MARTINA).account.setLanguage({ language: "es" });
    expect(await world.caller(DIEGO).account.preferences()).toEqual({ language: "en" });
    expect(await world.caller(MARTINA).account.preferences()).toEqual({ language: "es" });
  });

  it("stores one row under the sub, outside every world and with no TTL, and changing it keeps one row", async () => {
    const world = await consoleWorld();
    await world.caller(DIEGO).account.setLanguage({ language: "en" });
    await world.caller(DIEGO).account.setLanguage({ language: "es" });
    const row = await world.stores.client.get("Runtime", accountPreferencesKey(SUBS.diego));
    expect(row).toMatchObject({ PK: `ACCOUNT#${SUBS.diego}`, SK: "PREFS", entity: "AccountPreferences", sub: SUBS.diego, language: "es", version: 2 });
    expect(row).not.toHaveProperty("expiresAt");
    expect(row).not.toHaveProperty("world");
    expect(row).not.toHaveProperty("clockId");
    expect(world.stores.client.dump("Runtime").filter((entry) => entry.PK.startsWith("ACCOUNT#"))).toHaveLength(1);
  });

  it("accepts only es and en, and no other field (zod strict)", async () => {
    const world = await consoleWorld();
    const diego = world.caller(DIEGO);
    await expect(diego.account.setLanguage({ language: "fr" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(diego.account.setLanguage({} as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(diego.account.setLanguage({ language: "en", sub: SUBS.martina } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await diego.account.preferences()).toEqual({ language: null });
    expect(world.stores.client.dump("Runtime").filter((entry) => entry.PK.startsWith("ACCOUNT#"))).toEqual([]);
  });

  it("the sub is the token's, never the input's: nobody writes another user's language", async () => {
    const world = await consoleWorld();
    await world.caller(DIEGO).account.setLanguage({ language: "en" });
    expect(await world.caller(MARTINA).account.preferences()).toEqual({ language: null });
  });

  it("keeps no email in the row: the sub and the language are all it says", async () => {
    const world = await consoleWorld();
    await world.caller(DIEGO).account.setLanguage({ language: "en" });
    const row = await world.stores.client.get("Runtime", accountPreferencesKey(SUBS.diego));
    expect(Object.keys(row ?? {}).sort()).toEqual(["PK", "SK", "createdAt", "entity", "language", "sub", "synthetic", "updatedAt", "version"]);
  });
});

describe("[FL-133] the language of a guest", () => {
  let stores: MemoryStores;
  let access: TestAccess;
  let bff: Bff;

  beforeEach(() => {
    stores = memoryStores();
    access = testAccessDeps(stores, { now: () => NOW });
    bff = bffFor(stores, access);
  });

  /** A public guest's token before its world exists: no firm yet (auth-triggers/pre-token.ts). */
  const token = (claims: Record<string, unknown> = {}): string =>
    bff.issuer.idToken({ sub: GUEST_SUB, "cognito:username": "usr-01j9zq00000000000000000002", email: "ana.gomez@despachos-del-sur.com.ar", "custom:firmId": undefined, "custom:role": "GUEST", "custom:isGuest": "true", "cognito:groups": ["GUEST"], auth_time: Math.floor(NOW.getTime() / 1000), ...claims });
  const headers = (bearer: string) => ({ "x-legajo-auth": `Bearer ${bearer}` });
  const read = (bearer: string) => call(bff, trpcEvent("GET", "/api/account.preferences", { input: {}, headers: headers(bearer) }));
  const write = (bearer: string, input: unknown) => call(bff, trpcEvent("POST", "/api/account.setLanguage", { input, headers: headers(bearer) }));

  it("works before its world exists: the preference is the account's", async () => {
    expect(await read(token())).toMatchObject({ status: 200, data: { language: null } });
    expect(await write(token(), { language: "en" })).toMatchObject({ status: 200, data: { language: "en" } });
    expect(await read(token())).toMatchObject({ status: 200, data: { language: "en" } });
  });

  it("is the same with the world's token, and it stays when that world is gone", async () => {
    await seedBrokers(stores, [{ firmId: "firm-guest-41", brokerId: "brk-guest-41", role: "GUEST", sub: GUEST_SUB }]);
    await write(token(), { language: "en" });
    // The world is destroyed: its rows, its broker row; a token that still names it is refused by the firm gate...
    await stores.client.delete("Firms", { PK: "FIRM#firm-guest-41", SK: "BROKER#brk-guest-41" });
    const stale = token({ "custom:firmId": "firm-guest-41", "custom:worldLease": "lease-1" });
    expect(await call(bff, trpcEvent("GET", "/api/clock.get", { input: {}, headers: headers(stale) }))).toMatchObject({ status: 403, error: { reason: "GUEST_WORLD_GONE" } });
    // ...but the account's own preference does not need the world.
    expect(await read(stale)).toMatchObject({ status: 200, data: { language: "en" } });
  });

  it("needs a verified token: no token, a token with no firm and an inactive broker are refused, and nothing is stored", async () => {
    await seedBrokers(stores, [{ firmId: "firm-delta", brokerId: "brk-delta-gone", role: "BROKER", sub: "0b7f0e2e-0000-4000-8000-0000000000ee", active: false }]);
    expect(await call(bff, trpcEvent("GET", "/api/account.preferences", { input: {} }))).toMatchObject({ status: 401, error: { reason: "TOKEN_MISSING" } });
    const noFirm = bff.issuer.idToken({ "custom:firmId": undefined, "custom:role": undefined, "cognito:groups": [] });
    expect(await write(noFirm, { language: "en" })).toMatchObject({ status: 401, error: { reason: "PRINCIPAL_INCOMPLETE" } });
    const inactive = bff.issuer.idToken({ sub: "0b7f0e2e-0000-4000-8000-0000000000ee" });
    expect(await write(inactive, { language: "en" })).toMatchObject({ status: 403, error: { reason: "BROKER_INACTIVE" } });
    expect(await read(inactive)).toMatchObject({ status: 403 });
    expect(stores.client.dump("Runtime").filter((entry) => entry.PK.startsWith("ACCOUNT#"))).toEqual([]);
  });
});
