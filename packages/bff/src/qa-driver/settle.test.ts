import { describe, expect, it } from "vitest";
import type { MemoryStores } from "../connector/index";
import { REAL_NOW } from "../connector/testing";
import { SETTLE_HOLD_MS, settleOperation } from "./settle";
import { QA_CLOCK, qaDriverStores } from "./testing";

const OPERATION = "op-7001";

function fakeTime(onSleep: (atMs: number) => Promise<void> | void = () => undefined) {
  let at = Date.parse(REAL_NOW);
  return {
    now: () => new Date(at),
    sleep: async (ms: number) => {
      at += ms;
      await onSleep(at);
    },
    elapsed: () => at - Date.parse(REAL_NOW),
  };
}

async function settle(stores: MemoryStores, time: ReturnType<typeof fakeTime>, timeoutSec = 300) {
  return settleOperation({ data: stores.connector, now: time.now, sleep: time.sleep }, { operationId: OPERATION, timeoutSec });
}

describe("op.settle: quiescence before negatives (docs/test-plan.md §4.3)", () => {
  it("returns once a quiet operation stayed quiet for 10 real seconds", async () => {
    const stores = await qaDriverStores();
    const time = fakeTime();
    const settled = await settle(stores, time);
    expect(settled).toMatchObject({ settled: true, stale: [] });
    expect(time.elapsed()).toBeGreaterThanOrEqual(SETTLE_HOLD_MS);
  });

  it("waits for an event in flight and restarts the hold when it leaves", async () => {
    const stores = await qaDriverStores();
    const event = { operationId: OPERATION, clockId: QA_CLOCK, eventId: "evt-1" };
    await stores.connector.world.markInFlight(event);
    const time = fakeTime(async (at) => {
      if (at - Date.parse(REAL_NOW) >= 30_000) await stores.connector.world.settleInFlight(event);
    });
    await settle(stores, time);
    expect(time.elapsed()).toBeGreaterThanOrEqual(30_000 + SETTLE_HOLD_MS);
  });

  it("waits for a mail of its world until the receiver closes it, and only reports a stale one", async () => {
    const stores = await qaDriverStores();
    const mail = { clockId: QA_CLOCK, mailId: "qa0123456789", operationId: OPERATION, from: "op-7001-q7p2q9@legajo.demo.craftech.io", to: "qa-sc01a@sim.legajo.demo.craftech.io", profile: "SYSTEM" as const, awaiting: "SIMMAIL" as const, sentAtReal: REAL_NOW };
    await stores.connector.world.putMailPending(mail);
    const time = fakeTime(async (at) => {
      if (at - Date.parse(REAL_NOW) >= 20_000) await stores.connector.world.closeMailPending({ clockId: QA_CLOCK, mailId: mail.mailId, from: mail.from });
    });
    await settle(stores, time);
    expect(time.elapsed()).toBeGreaterThanOrEqual(20_000 + SETTLE_HOLD_MS);

    await stores.connector.world.putMailPending({ ...mail, mailId: "qa9876543210", staleAtReal: REAL_NOW });
    const later = await settle(stores, fakeTime());
    expect(later.stale).toEqual([{ kind: "MAIL", detail: "SIMMAIL qa9876543210" }]);
  });

  it("counts a timer due at the world's simulated now, but not one of another operation", async () => {
    const stores = await qaDriverStores();
    const due = { clockId: QA_CLOCK, kind: "DEFERRED_SEND" as const, dueAtSim: "2026-10-14T10:00:00-03:00", status: "SCHEDULED" as const, payload: {} };
    await stores.connector.timers.createTimer({ ...due, operationId: "op-7002", clockId: "qa-812-1-sc02", timerId: "other" });
    await expect(settle(stores, fakeTime())).resolves.toMatchObject({ settled: true });
    await stores.connector.timers.createTimer({ ...due, operationId: OPERATION, timerId: "mine" });
    await expect(settle(stores, fakeTime(), 30)).rejects.toMatchObject({ code: "UNAVAILABLE", reason: "NOT_SETTLED", message: expect.stringContaining("TIMER TIMER#DEFERRED_SEND#mine") });
  });

  it("fails at the deadline naming what is pending, never with an address", async () => {
    const stores = await qaDriverStores();
    await stores.connector.world.markInFlight({ operationId: OPERATION, clockId: QA_CLOCK, eventId: "evt-stuck" });
    const failure = await settle(stores, fakeTime(), 60).catch((error: unknown) => error as Error);
    expect(failure).toMatchObject({ reason: "NOT_SETTLED" });
    expect((failure as Error).message).toContain("EVENT evt-stuck");
    expect((failure as Error).message).not.toContain("@");
  });
});
