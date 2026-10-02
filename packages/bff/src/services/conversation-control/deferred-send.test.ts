import { describe, expect, it } from "vitest";
import { timerKeyOf } from "../../domain/timers";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { CLOCK, FIRM, OPERATION, START_SIM, type ServiceWorld, serviceWorld } from "../operations-admin/testing";
import { deferredSendAction, deferredSendHandler } from "./deferred-send";

const MESSAGE = "msg-deferred1";
const TIMER_KEY = timerKeyOf("DEFERRED_SEND", MESSAGE);
const NEXT_ALLOWED = "2026-10-16T09:00:00+08:00";

async function deferredEmail(world: ServiceWorld, status: "DEFERRED" | "SENT" = "DEFERRED"): Promise<void> {
  await world.stores.connector.conversations.appendMessage({
    messageId: MESSAGE,
    operationId: OPERATION,
    firmId: FIRM,
    clockId: CLOCK,
    direction: "OUT",
    channel: "EMAIL",
    kind: "DOCS_REQUEST",
    counterpart: "SUPPLIER",
    contactId: "ctc-qingdao-1",
    to: "supplier-qingdao@sim.legajo.demo.craftech.io",
    from: "op-4471-k7p2q9@legajo.demo.craftech.io",
    body: "Please send the packing list.",
    status,
    author: "AGENT",
    deferredTimerKey: TIMER_KEY,
    sentAtSim: START_SIM,
    sentAtReal: "2026-09-26T15:00:00.000Z",
  });
}

describe("deferred_send [FL-033]", () => {
  it("[FL-033] when its timer falls due, the pipeline decides the deferred message again at that instant", async () => {
    const world = await serviceWorld();
    await deferredEmail(world);
    const answer = unwrapDirect(await deferredSendHandler(world.deps)({ caller: { kind: "WORKER", firmId: FIRM }, operationId: OPERATION, clockId: CLOCK, messageId: MESSAGE, timerKey: TIMER_KEY, atSim: NEXT_ALLOWED }));
    expect(answer).toMatchObject({ outcome: "SENT" });
    expect(world.resent).toEqual([{ messageId: MESSAGE, timerKey: TIMER_KEY, atSim: NEXT_ALLOWED }]);
  });

  it("[FL-033] the fire_timer action reports the pipeline's answer, and skips a message no longer deferred under this timer", async () => {
    const world = await serviceWorld({ deferred: { status: "DEFERRED", nextAllowedAt: "2026-10-19T09:00:00+08:00" } });
    await deferredEmail(world);
    const action = deferredSendAction(world.deps);
    const timer = await world.stores.connector.timers.createTimer({ operationId: OPERATION, clockId: CLOCK, kind: "DEFERRED_SEND", timerId: MESSAGE, dueAtSim: NEXT_ALLOWED, status: "SCHEDULED" });
    const firing = { operationId: OPERATION, clockId: CLOCK, firmId: FIRM, timerKey: TIMER_KEY, version: timer.version, dueAtSim: NEXT_ALLOWED, eventAtSim: NEXT_ALLOWED, firedBy: "CLOCK" as const };
    expect(await action({ timer, firing })).toEqual({ outcome: "FIRED", detail: { sendStatus: "DEFERRED", nextAllowedAt: "2026-10-19T09:00:00+08:00" } });

    const sent = await serviceWorld();
    await deferredEmail(sent, "SENT");
    expect(await deferredSendAction(sent.deps)({ timer, firing })).toEqual({ outcome: "SKIPPED", reason: "MESSAGE_NOT_DEFERRED" });
    expect(sent.resent).toEqual([]);
  });

  it("is the worker's and the scheduler's only", async () => {
    const world = await serviceWorld();
    const answer = await deferredSendHandler(world.deps)({ caller: { kind: "CONSOLE", firmId: FIRM, brokerId: "brk-delta-diego", role: "BROKER" }, operationId: OPERATION, clockId: CLOCK, messageId: MESSAGE, timerKey: TIMER_KEY, atSim: NEXT_ALLOWED });
    expect(answer).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "CALLER_NOT_ALLOWED" } });
  });
});
