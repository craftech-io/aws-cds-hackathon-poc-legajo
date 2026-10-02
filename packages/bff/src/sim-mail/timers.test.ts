import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import type { Timer } from "../domain/timers";
import { startRunning } from "../lib/clock";
import { SimReplyHandoff } from "../timers/events";
import { SimMailInvocation, isSendNow, simReplyInvocation } from "./contract";
import { receiveSimMail } from "./receive";
import { fireSimReply, simTimerDeps } from "./supplier-simulator";
import { scheduleSimReply, simReplyTimerId } from "./timers";
import { CLOCK, QINGDAO, REAL_NOW, type SimWorld, deliverSim, recordOutbound, simTimers, simWorld } from "./testing";

const ses = mockClient(SESv2Client);
let world: SimWorld;
let timer: Timer;

beforeEach(async () => {
  ses.reset();
  ses.on(SendEmailCommand).resolves({ MessageId: "0100019a2b3c4d5e-sim-reply-1" });
  world = await simWorld();
  await recordOutbound(world, { messageId: "msg-4471outt1", providerMessageId: "0100019a2b3c4d5e-out-t1", to: QINGDAO, docTypes: ["PACKING_LIST"] });
  const event = deliverSim(world, { sesMessageId: "ses-in-t1", recipient: QINGDAO, from: world.email.op4471.threadAddress, rfcMessageId: "<0100019a2b3c4d5e-out-t1@email.amazonses.com>", operationNumber: "4471", request: "kind=DOCS_REQUEST; docs=PACKING_LIST" });
  await receiveSimMail(event, world.deps);
  const [created] = await simTimers(world);
  if (created === undefined) throw new Error("no timer");
  timer = created;
});

const key = () => `TIMER#SIM_REPLY#${timer.timerId}`;
const invoke = (overrides: Partial<Parameters<typeof simReplyInvocation>[0]> = {}) => simReplyInvocation({ clockId: CLOCK, operationId: "op-4471", timerKey: key(), dueAtSim: timer.dueAtSim, version: timer.version, ...overrides });
const timerAudits = async () => (await world.email.stores.connector.audit.listByOperation("op-4471")).filter((row) => row.action.startsWith("TIMER_")).map((row) => row.action);
const audits = async (action: string) => (await world.email.stores.connector.audit.listByOperation("op-4471")).filter((row) => row.action === action);

describe("[FL-088] a TIMER#SIM_REPLY sends its reply once, whoever fires it", () => {
  it("[FL-088] the clock's path: a timer advance_clock already marked FIRED is sent; a late schedule of the same timer sends nothing more", async () => {
    await world.email.stores.connector.timers.completeTimer({ operationId: "op-4471", timerKey: key(), status: "FIRED", firedBy: "CLOCK", atSim: timer.dueAtSim, expectedVersion: timer.version });
    expect(await fireSimReply(world.deps, invoke({ firedBy: "CLOCK", version: timer.version + 1 }))).toMatchObject({ status: "SENT" });
    expect(await fireSimReply(world.deps, invoke())).toEqual({ status: "SKIPPED", reason: "ALREADY_SENT" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it("[FL-088] a schedule of an older version of the timer (it was moved) is stale and sends nothing", async () => {
    expect(await fireSimReply(world.deps, invoke({ version: timer.version + 3 }))).toEqual({ status: "SKIPPED", reason: "STALE_SCHEDULE" });
    expect((await simTimers(world))[0]?.status).toBe("SCHEDULED");
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("[FL-088] a cancelled timer, an unknown key or another world's clock sends nothing", async () => {
    await world.email.stores.connector.timers.completeTimer({ operationId: "op-4471", timerKey: key(), status: "CANCELLED", atSim: timer.dueAtSim });
    expect(await fireSimReply(world.deps, invoke())).toEqual({ status: "SKIPPED", reason: "TIMER_CANCELLED" });
    expect(await fireSimReply(world.deps, invoke({ timerKey: "TIMER#SIM_REPLY#sr-nothing" }))).toEqual({ status: "SKIPPED", reason: "TIMER_NOT_FOUND" });
    expect(await fireSimReply(world.deps, invoke({ clockId: "GLOBAL#firm-norte" }))).toEqual({ status: "SKIPPED", reason: "TIMER_MISMATCH" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("[FL-088] the schedule's path: a SCHEDULED timer is claimed at its version, sent, audited TIMER_FIRED once and left FIRED by SCHEDULER", async () => {
    expect(await fireSimReply(world.deps, invoke())).toMatchObject({ status: "SENT" });
    expect((await simTimers(world))[0]).toMatchObject({ status: "FIRED", firedBy: "SCHEDULER" });
    expect(await timerAudits()).toEqual(["TIMER_FIRED"]);
    expect(await fireSimReply(world.deps, invoke())).toMatchObject({ status: "SKIPPED" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it("[FL-088] the daily cap holds at firing time too: the reply is skipped and audited", async () => {
    const operations = world.email.stores.connector.operations;
    const current = await operations.getOperation("op-4471");
    await operations.updateOperation("op-4471", { simState: { ...current.simState, repliesOnRealDay: { day: REAL_NOW.slice(0, 10), count: 6 } } }, current.version);
    expect(await fireSimReply(world.deps, invoke())).toEqual({ status: "SKIPPED", reason: "REPLY_CAP" });
    expect(await audits("SIM_REPLY_SKIPPED")).toEqual([expect.objectContaining({ reason: "REPLY_CAP", refs: { operationId: "op-4471", timerKey: key() } })]);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("[FL-088] the fence of the SIMULATOR profile still decides: a contact that bounced since is refused, and nothing is sent", async () => {
    await world.email.stores.connector.parties.transitionContact({ supplierId: "sup-qingdao", contactId: "ctc-qingdao-1", to: "BOUNCED", atSim: timer.dueAtSim, by: "SYSTEM" });
    expect(await fireSimReply(world.deps, invoke())).toEqual({ status: "REFUSED", code: "INVALID", reason: "SIMULATOR_FROM" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect((await world.email.stores.connector.audit.listByDecision("firm-delta", "DENY")).map((row) => row.action)).toContain("EMAIL_FENCE");
  });

  it("[FL-088] an SES failure is audited and surfaces; the timer stays sent-once", async () => {
    ses.on(SendEmailCommand).rejects(Object.assign(new Error("throttled"), { name: "TooManyRequestsException" }));
    await expect(fireSimReply(world.deps, invoke())).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await audits("SIM_REPLY_FAILED")).toHaveLength(1);
    expect(await fireSimReply(world.deps, invoke())).toMatchObject({ status: "SKIPPED" });
  });
});

describe("[FL-088] the invocation contract of SimMail", () => {
  it("[FL-088] simReplyInvocation builds what ScheduleDispatch and advance_clock send; only SIM_REPLY timers and the two modes are accepted", () => {
    expect(invoke()).toEqual({ action: "sim_reply", mode: "TIMER", clockId: CLOCK, operationId: "op-4471", timerKey: key(), dueAtSim: timer.dueAtSim, version: timer.version, firedBy: "SCHEDULER" });
    expect(() => simReplyInvocation({ clockId: CLOCK, operationId: "op-4471", timerKey: "TIMER#MILESTONE#DOCS_REQUEST", dueAtSim: timer.dueAtSim, version: 1 })).toThrow();
    expect(SimMailInvocation.safeParse({ action: "sim_reply", mode: "SEND_NOW", clockId: CLOCK, operationId: "op-4471", docTypes: [], version: 1, mailId: "qa00112233445566" }).success).toBe(false);
    expect(SimMailInvocation.safeParse({ ...invoke(), extra: true }).success).toBe(false);
  });
});

describe("[FL-088] the timers of a RUNNING world", () => {
  const running = async () => {
    const state = world.email.stores.connector.world;
    const clock = await state.getClock(CLOCK);
    await state.updateClock(CLOCK, startRunning(clock, Date.parse(REAL_NOW)));
  };

  it("[FL-088] a reply 10 simulated minutes away in a RUNNING world gets its real schedule (tm-d-…, the timer's ScheduleInput)", async () => {
    await running();
    await recordOutbound(world, { messageId: "msg-4471outt2", providerMessageId: "0100019a2b3c4d5e-out-t2", to: QINGDAO, docTypes: ["CERTIFICATE_OF_ORIGIN"] });
    await receiveSimMail(deliverSim(world, { sesMessageId: "ses-in-t2", recipient: QINGDAO, from: world.email.op4471.threadAddress, rfcMessageId: "<0100019a2b3c4d5e-out-t2@email.amazonses.com>", operationNumber: "4471", request: "kind=DOCS_REQUEST; docs=CERTIFICATE_OF_ORIGIN" }), world.deps);
    const armed = (await simTimers(world)).find((candidate) => candidate.timerId === simReplyTimerId("ses-in-t2", "REPLY"));
    expect(armed).toMatchObject({ status: "SCHEDULED" });
    const specs = [...world.scheduler.schedules.values()];
    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toMatch(/^tm-d-[0-9a-f]{32}$/);
    expect(specs[0]?.input).toEqual({ clockId: CLOCK, operationId: "op-4471", timerKey: `TIMER#SIM_REPLY#${armed?.timerId}`, dueAtSim: armed?.dueAtSim, version: armed?.version });
    expect(specs[0]?.at.getTime()).toBe(Date.parse(REAL_NOW) + 10 * 60_000);
  });

  it("[FL-088] a reply 60 real seconds away or less is dispatched at once: SimMail sends it in process, without a schedule", async () => {
    await running();
    const operation = await world.email.stores.connector.operations.getOperation("op-4471");
    const simNow = Date.parse(REAL_NOW) + (await world.email.stores.connector.world.getClock(CLOCK)).offsetMs;
    const payload = { phase: "REPLY" as const, behaviour: "PROMPT" as const, request: { kind: "DOCS_REQUEST" as const, docTypes: ["PACKING_LIST" as const] }, answered: { messageId: "msg-4471outt1", rfcMessageId: "<0100019a2b3c4d5e-out-t1@email.amazonses.com>", references: [], subject: "[Op 4471] Missing documents", threadAddress: world.email.op4471.threadAddress, mailbox: QINGDAO } };
    const armed = await scheduleSimReply(simTimerDeps(world.deps), { operation, timerId: "sr-direct-1", dueAtSim: new Date(simNow + 30_000).toISOString(), payload });
    expect(world.scheduler.schedules.size).toBe(0);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect(await world.email.stores.connector.timers.getTimer("op-4471", `TIMER#SIM_REPLY#${armed.timerId}`)).toMatchObject({ status: "FIRED", firedBy: "SCHEDULER" });
  });
});

describe("[FL-088] the hand-off of the timers module", () => {
  it("[FL-088] a SimReplyHandoff as the dispatcher sends it is a TIMER invocation of SimMail, and it is sent", async () => {
    const handoff = SimReplyHandoff.parse({ clockId: CLOCK, operationId: "op-4471", timerKey: key(), dueAtSim: timer.dueAtSim, version: timer.version, firmId: "firm-delta", firedBy: "CLOCK", eventAtSim: timer.dueAtSim });
    const parsed = SimMailInvocation.parse(handoff);
    expect(isSendNow(parsed)).toBe(false);
    if (isSendNow(parsed)) return;
    expect(await fireSimReply(world.deps, parsed)).toMatchObject({ status: "SENT" });
    expect((await simTimers(world))[0]).toMatchObject({ status: "FIRED", firedBy: "CLOCK" });
  });
});
