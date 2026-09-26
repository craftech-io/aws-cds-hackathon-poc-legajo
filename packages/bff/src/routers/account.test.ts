import { describe, expect, it } from "vitest";
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
