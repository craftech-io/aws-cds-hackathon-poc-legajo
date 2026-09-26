import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "@legajo/shared";
import { START_SIM } from "../connector/testing";
import { otherSessionOf } from "./account";
import { DIEGO, SUBS, consoleWorld, principalOf } from "./testing";

const JUDGE_CLOCK = "JUDGE#firm-judge-01";
const judge = (originJti: string) => principalOf("firm-judge-01", "JUDGE", SUBS.judge, "brk-judge-01", { originJti });

describe("account router", () => {
  it("[FL-079] describes a broker's session and what it may change", async () => {
    const world = await consoleWorld();
    const session = await world.caller(DIEGO).account.session();
    expect(session).toMatchObject({ firm: { firmId: "firm-delta", name: "Estudio Delta", kind: "DEMO" }, firmId: "firm-delta", role: "BROKER", isJudge: false, brokerId: "brk-delta-diego", recentLogin: true, canChangePassword: true, canSetUpMfa: true, otherSession: null });
  });

  it("[FL-079] tells a judge when another session used the world in the last two hours", async () => {
    const first = await consoleWorld({ now: new Date("2026-09-26T15:00:00.000Z") });
    await first.stores.connector.world.createClock({ clockId: JUDGE_CLOCK, firmId: "firm-judge-01", mode: "PAUSED", pausedSimNow: START_SIM, startAtSim: START_SIM, worldEpoch: 1 });
    const opened = await first.caller(judge("jti-a")).account.session();
    expect(opened).toMatchObject({ isJudge: true, worldReady: true, otherSession: null, canChangePassword: false, canSetUpMfa: false });
    expect((await first.caller(judge("jti-a")).account.session()).otherSession).toBeNull();
    expect((await first.caller(judge("jti-b")).account.session()).otherSession).toEqual({ lastActiveAtReal: "2026-09-26T15:00:00.000Z", minutesAgo: 0 });
    const clock = await first.stores.connector.world.getClock(JUDGE_CLOCK);
    expect(clock.lastSession).toMatchObject({ originJti: "jti-b" });
  });

  it("[FL-079] keeps warning while the other session is still working hours after its sign-in", async () => {
    let now = new Date("2026-09-26T13:00:00.000Z");
    const world = await consoleWorld({ wallClock: () => now, judgeWorld: true });
    expect((await world.caller(judge("jti-a")).account.session()).otherSession).toBeNull();
    now = new Date("2026-09-26T15:20:00.000Z");
    await world.caller(judge("jti-a")).clock.get({});
    const refreshed = await world.stores.connector.world.getClock(JUDGE_CLOCK);
    expect(refreshed.lastSession).toMatchObject({ originJti: "jti-a", lastActiveAtReal: "2026-09-26T15:20:00.000Z" });
    // Within a minute the same session does not write again.
    now = new Date("2026-09-26T15:20:30.000Z");
    await world.caller(judge("jti-a")).clock.get({});
    expect((await world.stores.connector.world.getClock(JUDGE_CLOCK)).version).toBe(refreshed.version);
    now = new Date("2026-09-26T15:30:00.000Z");
    expect((await world.caller(judge("jti-b")).account.session()).otherSession).toEqual({ lastActiveAtReal: "2026-09-26T15:20:00.000Z", minutesAgo: 10 });
  });

  it("[FL-079] never moves the last session back in time", async () => {
    let now = new Date("2026-09-26T15:00:00.000Z");
    const world = await consoleWorld({ wallClock: () => now, judgeWorld: true });
    await world.caller(judge("jti-b")).account.session();
    now = new Date("2026-09-26T14:59:00.000Z");
    await world.caller(judge("jti-a")).clock.get({});
    expect((await world.stores.connector.world.getClock(JUDGE_CLOCK)).lastSession).toMatchObject({ originJti: "jti-b", lastActiveAtReal: "2026-09-26T15:00:00.000Z" });
  });

  it("[FL-079] keeps the notice when the sign-in's own write loses the race on the clock's version", async () => {
    let now = new Date("2026-09-26T15:00:00.000Z");
    const world = await consoleWorld({ wallClock: () => now, judgeWorld: true });
    await world.caller(judge("jti-a")).account.session();
    now = new Date("2026-09-26T15:10:00.000Z");
    const conflict = vi.spyOn(world.stores.connector.world, "updateClock").mockRejectedValue(new ConnectorError("CONFLICT", "version moved"));
    expect((await world.caller(judge("jti-b")).account.session()).otherSession).toEqual({ lastActiveAtReal: "2026-09-26T15:00:00.000Z", minutesAgo: 10 });
    conflict.mockRestore();
  });

  it("[FL-079] answers the notice to every concurrent and repeated check of the same sign-in", async () => {
    let now = new Date("2026-09-26T15:00:00.000Z");
    const world = await consoleWorld({ wallClock: () => now, judgeWorld: true });
    await world.caller(judge("jti-a")).account.session();
    now = new Date("2026-09-26T15:05:00.000Z");
    const second = world.caller(judge("jti-b"));
    // The shell's first batch: the sign-in check twice (StrictMode) and a clock read, all at once.
    const [first, doubled] = await Promise.all([second.account.session(), second.account.session(), second.clock.get({})]);
    const notice = { lastActiveAtReal: "2026-09-26T15:00:00.000Z", minutesAgo: 5 };
    expect(first.otherSession).toEqual(notice);
    expect(doubled.otherSession).toEqual(notice);
    expect((await second.account.session()).otherSession).toEqual(notice);
    expect((await world.stores.connector.world.getClock(JUDGE_CLOCK)).lastSession).toMatchObject({ originJti: "jti-b", previous: { originJti: "jti-a" } });
    // The first session is told about the second one, and nobody past two idle hours.
    expect((await world.caller(judge("jti-a")).account.session()).otherSession).toEqual({ lastActiveAtReal: "2026-09-26T15:05:00.000Z", minutesAgo: 0 });
    now = new Date("2026-09-26T17:06:00.000Z");
    expect((await second.account.session()).otherSession).toBeNull();
  });

  it("[FL-079] says so when the judge world does not exist yet", async () => {
    const world = await consoleWorld();
    expect(await world.caller(judge("jti-a")).account.session()).toMatchObject({ firm: null, worldReady: false, otherSession: null });
  });

  it("[FL-079] forgets another session after two idle hours", () => {
    const clock = { lastSession: { originJti: "jti-a", authTime: 0, lastActiveAtReal: "2026-09-26T13:00:00.000Z" } };
    expect(otherSessionOf(clock, "jti-b", new Date("2026-09-26T14:59:00.000Z"))).toEqual({ lastActiveAtReal: "2026-09-26T13:00:00.000Z", minutesAgo: 119 });
    expect(otherSessionOf(clock, "jti-b", new Date("2026-09-26T15:00:00.000Z"))).toBeNull();
  });
});
