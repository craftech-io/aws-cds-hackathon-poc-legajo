import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "@legajo/shared";
import { createTestIssuer, testContextDeps } from "../auth/testing";
import { REAL_NOW, memoryStores } from "../connector/testing";
import { testAccessDeps } from "../signup/testing";
import { createConsoleCaller } from "./index";
import { serverContext } from "./trpc";
import { DIEGO, SUBS, consoleWorld, principalOf, seedConsoleWorld } from "./testing";

const GUEST_CLOCK = "GUEST#firm-guest-01";
const guest = (originJti: string) => principalOf("firm-guest-01", "GUEST", SUBS.guest, "brk-guest-01", { originJti });

describe("account router", () => {
  it("[FL-079] describes a broker's session and what it may change", async () => {
    const world = await consoleWorld();
    const session = await world.caller(DIEGO).account.session();
    expect(session).toMatchObject({ firm: { firmId: "firm-delta", name: "Estudio Delta", kind: "DEMO" }, firmId: "firm-delta", role: "BROKER", isGuest: false, brokerId: "brk-delta-diego", recentLogin: true, canChangePassword: true, canSetUpMfa: true });
  });

  it("[FL-079] records the guest's sign-in as the last session of its world", async () => {
    const first = await consoleWorld({ now: new Date("2026-09-26T15:00:00.000Z"), guestWorld: true });
    const opened = await first.caller(guest("jti-a")).account.session();
    expect(opened).toMatchObject({ isGuest: true, worldReady: true, canChangePassword: false, canSetUpMfa: false });
    expect(opened).not.toHaveProperty("otherSession");
    expect((await first.stores.connector.world.getClock(GUEST_CLOCK)).lastSession).toMatchObject({ originJti: "jti-a", lastActiveAtReal: "2026-09-26T15:00:00.000Z" });
    await first.caller(guest("jti-b")).account.session();
    const clock = await first.stores.connector.world.getClock(GUEST_CLOCK);
    expect(clock.lastSession).toMatchObject({ originJti: "jti-b" });
    expect(clock.lastSession).not.toHaveProperty("previous");
  });

  it("[FL-079] keeps the last session fresh while it is still working hours after its sign-in", async () => {
    let now = new Date("2026-09-26T13:00:00.000Z");
    const world = await consoleWorld({ wallClock: () => now, guestWorld: true });
    await world.caller(guest("jti-a")).account.session();
    now = new Date("2026-09-26T15:20:00.000Z");
    await world.caller(guest("jti-a")).clock.get({});
    const refreshed = await world.stores.connector.world.getClock(GUEST_CLOCK);
    expect(refreshed.lastSession).toMatchObject({ originJti: "jti-a", lastActiveAtReal: "2026-09-26T15:20:00.000Z" });
    // Within a minute the same session does not write again.
    now = new Date("2026-09-26T15:20:30.000Z");
    await world.caller(guest("jti-a")).clock.get({});
    expect((await world.stores.connector.world.getClock(GUEST_CLOCK)).version).toBe(refreshed.version);
  });

  it("[FL-079] never moves the last session back in time", async () => {
    let now = new Date("2026-09-26T15:00:00.000Z");
    const world = await consoleWorld({ wallClock: () => now, guestWorld: true });
    await world.caller(guest("jti-b")).account.session();
    now = new Date("2026-09-26T14:59:00.000Z");
    await world.caller(guest("jti-a")).clock.get({});
    expect((await world.stores.connector.world.getClock(GUEST_CLOCK)).lastSession).toMatchObject({ originJti: "jti-b", lastActiveAtReal: "2026-09-26T15:00:00.000Z" });
  });

  it("[FL-079] answers the sign-in even when its own write loses the race on the clock's version", async () => {
    let now = new Date("2026-09-26T15:00:00.000Z");
    const world = await consoleWorld({ wallClock: () => now, guestWorld: true });
    await world.caller(guest("jti-a")).account.session();
    now = new Date("2026-09-26T15:10:00.000Z");
    const conflict = vi.spyOn(world.stores.connector.world, "updateClock").mockRejectedValue(new ConnectorError("CONFLICT", "version moved"));
    expect(await world.caller(guest("jti-b")).account.session()).toMatchObject({ isGuest: true, worldReady: true, world: "READY" });
    conflict.mockRestore();
  });

  it("[FL-079] [FL-105] says so when the guest world does not exist yet, with its state instead of a refusal", async () => {
    const stores = memoryStores();
    await seedConsoleWorld(stores);
    const deps = testContextDeps({ verifier: createTestIssuer().verifier(), stores, now: () => new Date(REAL_NOW) });
    const access = testAccessDeps(stores);
    const session = await createConsoleCaller(serverContext({ principal: guest("jti-a"), deps, access: () => access })).account.session();
    expect(session).toMatchObject({ firm: null, firmId: null, role: "GUEST", worldReady: false, world: "NONE", guestKind: "RESERVED", canChangePassword: false });
  });
});
