import { describe, expect, it } from "vitest";
import { derivedEventId, turnEventId } from "../channels/adapter";
import type { EtaChangedEvent } from "../worker/events";
import { rescheduleOnEtaChange } from "./reschedule";
import { scheduleMilestones } from "./schedule";
import { CLOCK, ETA, FIRM, OPERATION, type TimeWorld, timeWorld } from "./testing";

const instant = (iso: string) => new Date(iso).getTime();

function etaEvent(eta: string, eventAtSim: string, key = eta): EtaChangedEvent {
  return { type: "ETA_CHANGED", eventId: derivedEventId("ETA_CHANGED", key), operationId: OPERATION, clockId: CLOCK, firmId: FIRM, eventAtSim, eta, previousEta: ETA, occurredAtSim: eventAtSim };
}

async function withMilestones(): Promise<TimeWorld> {
  const world = await timeWorld();
  await scheduleMilestones({ operation: await world.connector.operations.getOperation(OPERATION) }, world.timerDeps());
  return world;
}

async function milestones(world: TimeWorld) {
  const timers = await world.connector.timers.listTimers(OPERATION, { kind: "MILESTONE" });
  return Object.fromEntries(timers.map((timer) => [timer.timerId, timer]));
}

describe("reschedule_on_eta_change [FL-061] [FL-062] [FL-063] [FL-064]", () => {
  it("[FL-061] the ETA moves two days earlier: five new instants, version + 1, the one now past fires once as ETA_CHANGE", async () => {
    const world = await withMilestones();
    const event = etaEvent("2026-10-20T08:00:00-03:00", "2026-10-15T09:58:00-03:00");
    const result = await rescheduleOnEtaChange(event, { ...world.timerDeps(), sink: world.sink });
    const timers = await milestones(world);
    expect(instant(timers.DOCS_REQUEST!.dueAtSim)).toBe(instant("2026-10-13T10:00:00-03:00"));
    expect(instant(timers.FOLLOWUP!.dueAtSim)).toBe(instant("2026-10-15T10:00:00-03:00"));
    expect(instant(timers.FOLLOWUP_FINAL!.dueAtSim)).toBe(instant("2026-10-17T10:00:00-03:00"));
    expect(instant(timers.ESCALATION!.dueAtSim)).toBe(instant("2026-10-18T08:00:00-03:00"));
    expect(instant(timers.ARRIVAL!.dueAtSim)).toBe(instant("2026-10-20T08:00:00-03:00"));
    expect(Object.values(timers).every((timer) => timer.version === 2)).toBe(true);
    expect(result.fired).toEqual(["DOCS_REQUEST"]);
    const timerEvents = world.enqueued.filter((queued) => queued.type === "TIMER");
    expect(timerEvents).toEqual([expect.objectContaining({ timerKey: "TIMER#MILESTONE#DOCS_REQUEST", firedBy: "ETA_CHANGE", eventAtSim: event.eventAtSim, version: 2 })]);
    expect(world.scheduler.puts).toHaveLength(0);
    const operation = await world.connector.operations.getOperation(OPERATION);
    expect(instant(operation.eta)).toBe(instant("2026-10-20T08:00:00-03:00"));
    expect(operation.etaHistory.at(-1)).toMatchObject({ source: "CARRIER", eventId: event.eventId });
    expect(world.enqueued.find((queued) => queued.type === "AGENT_TURN")).toMatchObject({ trigger: "ETA_CHANGED", eventId: turnEventId("ETA_CHANGED", event.eventId) });
  });

  it("[FL-061] in a running world the schedules of the milestones inside the horizon move with them", async () => {
    const world = await withMilestones();
    await world.run("2026-10-18T07:40:00-03:00");
    await rescheduleOnEtaChange(etaEvent("2026-10-20T08:10:00-03:00", "2026-10-18T07:40:00-03:00"), { ...world.timerDeps(), sink: world.sink });
    expect(world.scheduler.puts.map((put) => put.input)).toEqual([expect.objectContaining({ timerKey: "TIMER#MILESTONE#ESCALATION", version: 2 })]);
    expect(world.scheduler.puts[0]?.at.getTime()).toBe(world.realNow.getTime() + 30 * 60_000);
  });

  it("[FL-062] the ETA moves later: later instants, version + 1, nothing fires; FIRED milestones and the agent's follow-ups stay", async () => {
    const world = await withMilestones();
    const docs = await world.connector.timers.getTimer(OPERATION, "TIMER#MILESTONE#DOCS_REQUEST");
    await world.connector.timers.completeTimer({ operationId: OPERATION, timerKey: "TIMER#MILESTONE#DOCS_REQUEST", status: "FIRED", firedBy: "CLOCK", atSim: docs.dueAtSim });
    const followup = await world.timer("FOLLOWUP_DUE", "fu-1", "2026-10-19T10:00:00-03:00");
    const result = await rescheduleOnEtaChange(etaEvent("2026-10-26T08:00:00-03:00", "2026-10-16T09:00:00-03:00"), { ...world.timerDeps(), sink: world.sink });
    const timers = await milestones(world);
    expect(result).toMatchObject({ fired: [], kept: ["DOCS_REQUEST"] });
    expect(timers.DOCS_REQUEST).toMatchObject({ status: "FIRED", dueAtSim: docs.dueAtSim });
    expect(instant(timers.FOLLOWUP!.dueAtSim)).toBe(instant("2026-10-21T10:00:00-03:00"));
    expect(instant(timers.ARRIVAL!.dueAtSim)).toBe(instant("2026-10-26T08:00:00-03:00"));
    expect(timers.FOLLOWUP!.version).toBe(2);
    expect(await world.connector.timers.getTimer(OPERATION, "TIMER#FOLLOWUP_DUE#fu-1")).toMatchObject({ dueAtSim: followup.dueAtSim, version: 1 });
    expect(world.enqueued.filter((queued) => queued.type === "TIMER")).toHaveLength(0);
  });

  it("[FL-063] an earlier ETA that leaves two milestones in the past fires each once, in order, as ETA_CHANGE", async () => {
    const world = await withMilestones();
    const docs = await world.connector.timers.getTimer(OPERATION, "TIMER#MILESTONE#DOCS_REQUEST");
    await world.connector.timers.completeTimer({ operationId: OPERATION, timerKey: "TIMER#MILESTONE#DOCS_REQUEST", status: "FIRED", firedBy: "CLOCK", atSim: docs.dueAtSim });
    const result = await rescheduleOnEtaChange(etaEvent("2026-10-19T08:00:00-03:00", "2026-10-16T12:00:00-03:00"), { ...world.timerDeps(), sink: world.sink });
    expect(result.fired).toEqual(["FOLLOWUP", "FOLLOWUP_FINAL"]);
    const fired = world.enqueued.filter((queued) => queued.type === "TIMER");
    expect(fired.map((queued) => (queued as { timerKey: string }).timerKey)).toEqual(["TIMER#MILESTONE#FOLLOWUP", "TIMER#MILESTONE#FOLLOWUP_FINAL"]);
    expect(fired.every((queued) => (queued as { firedBy: string }).firedBy === "ETA_CHANGE")).toBe(true);
    const timers = await milestones(world);
    expect(instant(timers.ESCALATION!.dueAtSim)).toBe(instant("2026-10-17T08:00:00-03:00"));
    expect(timers.ESCALATION!.status).toBe("SCHEDULED");
    expect(timers.DOCS_REQUEST!.status).toBe("FIRED");
  });

  it("[FL-064] the same feed event twice reschedules once: one version bump, one ETA_RESCHEDULED", async () => {
    const world = await withMilestones();
    const event = etaEvent("2026-10-24T08:00:00-03:00", "2026-10-14T11:00:00-03:00");
    await rescheduleOnEtaChange(event, { ...world.timerDeps(), sink: world.sink });
    const again = await rescheduleOnEtaChange(event, { ...world.timerDeps(), sink: world.sink });
    expect(again.repeated).toBe(true);
    expect(Object.values(await milestones(world)).every((timer) => timer.version === 2)).toBe(true);
    const audit = await world.connector.audit.listByOperation(OPERATION);
    expect(audit.filter((row) => row.action === "ETA_RESCHEDULED")).toHaveLength(1);
    expect((await world.connector.operations.getOperation(OPERATION)).etaHistory.filter((entry) => entry.eventId === event.eventId)).toHaveLength(1);
  });
});
