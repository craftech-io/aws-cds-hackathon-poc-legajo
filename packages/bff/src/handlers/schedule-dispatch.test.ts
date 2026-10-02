import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, FIRM, REAL_NOW, emailWorld, type EmailWorld } from "../channels/email/testing";
import { createLogger } from "../lib/log";
import { fakeScheduler } from "../sim-mail/testing";
import type { SimReplyHandoff, TimerEvent } from "../timers/events";
import { timerDispatcher } from "../timers/timers";
import { type ScheduleDispatchDeps, createScheduleDispatchHandler } from "./schedule-dispatch";

const OPERATION = "op-4471";
/** Before the world's paused "now" (15/10 22:10 UTC): already due. */
const DUE = "2026-10-15T21:00:00.000Z";

let world: EmailWorld;
let queued: TimerEvent[];
let handedOff: SimReplyHandoff[];
let lines: string[];

beforeEach(async () => {
  world = await emailWorld();
  queued = [];
  handedOff = [];
  lines = [];
});

function handler() {
  const log = createLogger({ level: "debug", sink: (line) => lines.push(line), now: () => new Date(REAL_NOW) });
  const deps: ScheduleDispatchDeps = {
    data: world.stores.connector,
    scheduler: fakeScheduler(),
    dispatcher: timerDispatcher({
      events: {
        enqueue: async (event) => {
          await world.stores.connector.world.markInFlight({ operationId: event.operationId, clockId: event.clockId, eventId: event.eventId });
          queued.push(event);
        },
      },
      simReply: async (handoff) => void handedOff.push(handoff),
    }),
    realClock: () => new Date(REAL_NOW),
    log,
  };
  return createScheduleDispatchHandler(() => deps, () => log);
}

async function timer(kind: "MILESTONE" | "SIM_REPLY", timerId: string) {
  return world.stores.connector.timers.createTimer({ operationId: OPERATION, clockId: CLOCK, kind, timerId, dueAtSim: DUE, status: "SCHEDULED", payload: {} });
}

describe("ScheduleDispatch entry", () => {
  it("[FL-064] a schedule at the timer's version enqueues TIMER on the FIFO, in flight first", async () => {
    const created = await timer("MILESTONE", "FOLLOWUP");
    const input = { clockId: CLOCK, operationId: OPERATION, timerKey: "TIMER#MILESTONE#FOLLOWUP", dueAtSim: DUE, version: created.version };
    expect(await handler()(input)).toEqual({ status: "DISPATCHED" });
    expect(queued).toMatchObject([{ type: "TIMER", operationId: OPERATION, clockId: CLOCK, firmId: FIRM, timerKey: "TIMER#MILESTONE#FOLLOWUP", version: created.version, firedBy: "SCHEDULER" }]);
    expect((await world.stores.connector.world.getOpState(OPERATION))?.inFlight).toEqual([queued[0]?.eventId]);
  });

  it("[FL-064] a schedule left over from before a move fires a stale version: audited, nothing enqueued", async () => {
    const created = await timer("MILESTONE", "FOLLOWUP");
    const input = { clockId: CLOCK, operationId: OPERATION, timerKey: "TIMER#MILESTONE#FOLLOWUP", dueAtSim: DUE, version: created.version + 1 };
    expect(await handler()(input)).toEqual({ status: "STALE" });
    expect(queued).toEqual([]);
    const trail = await world.stores.connector.audit.listByOperation(OPERATION);
    expect(trail.map((decision) => decision.action)).toContain("TIMER_STALE");
  });

  it("SIM_REPLY is handed to SimMail and never enters the queue", async () => {
    const created = await timer("SIM_REPLY", "01JQSIMREPLY000000000000001");
    const input = { clockId: CLOCK, operationId: OPERATION, timerKey: "TIMER#SIM_REPLY#01JQSIMREPLY000000000000001", dueAtSim: DUE, version: created.version };
    expect(await handler()(input)).toEqual({ status: "DISPATCHED" });
    expect(queued).toEqual([]);
    expect(handedOff).toMatchObject([{ operationId: OPERATION, timerKey: input.timerKey, version: created.version, firmId: FIRM, firedBy: "SCHEDULER" }]);
  });

  it("an input that is not a schedule's is dropped without its content in the log", async () => {
    expect(await handler()({ clockId: CLOCK, operationId: OPERATION, timerKey: "not-a-timer", dueAtSim: DUE, version: 1 })).toEqual({ status: "INVALID" });
    expect(queued).toEqual([]);
    expect(lines.join("\n")).not.toContain("not-a-timer");
  });
});
