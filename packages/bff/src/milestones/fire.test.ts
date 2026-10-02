import { describe, expect, it } from "vitest";
import { timerTurnEventId } from "../timers/events";
import { OPERATION, advanceDossier, handlersOf, timeWorld, timerEventFor } from "./testing";

const AT = { DOCS_REQUEST: "2026-10-15T10:00:00-03:00", FOLLOWUP: "2026-10-17T10:00:00-03:00", FOLLOWUP_FINAL: "2026-10-19T10:00:00-03:00" } as const;

async function fireMilestone(world: Awaited<ReturnType<typeof timeWorld>>, name: keyof typeof AT) {
  await world.timer("MILESTONE", name, AT[name]);
  const event = await timerEventFor(world, `TIMER#MILESTONE#${name}`);
  await handlersOf(world).fireTimer(event, world.workerContext());
  return event;
}

describe("fire_milestone [FL-008] [FL-064]", () => {
  for (const name of ["DOCS_REQUEST", "FOLLOWUP", "FOLLOWUP_FINAL"] as const) {
    it(`[FL-008] ${name} of a complete dossier is SKIPPED with MILESTONE_SKIPPED and no turn`, async () => {
      const world = await timeWorld();
      await world.validate("COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN");
      await fireMilestone(world, name);
      const timer = await world.connector.timers.getTimer(OPERATION, `TIMER#MILESTONE#${name}`);
      expect(timer).toMatchObject({ status: "SKIPPED", reason: "DOSSIER_COMPLETE" });
      expect(world.enqueued).toHaveLength(0);
      const audit = await world.connector.audit.listByOperation(OPERATION);
      expect(audit.find((row) => row.action === "MILESTONE_SKIPPED")?.refs).toMatchObject({ timerKey: `TIMER#MILESTONE#${name}` });
    });
  }

  it("[FL-008] an approved dossier skips its milestones the same way", async () => {
    const world = await timeWorld();
    await advanceDossier(world, true);
    await fireMilestone(world, "FOLLOWUP");
    expect((await world.connector.timers.getTimer(OPERATION, "TIMER#MILESTONE#FOLLOWUP")).reason).toBe("DOSSIER_APPROVED");
    expect(world.enqueued).toHaveLength(0);
  });

  it("an incomplete dossier opens an AGENT_TURN(MILESTONE) with the milestone and its timer, id derived from the TIMER event", async () => {
    const world = await timeWorld();
    const event = await fireMilestone(world, "DOCS_REQUEST");
    expect(world.enqueued).toEqual([
      expect.objectContaining({ type: "AGENT_TURN", trigger: "MILESTONE", milestone: "DOCS_REQUEST", timerKey: "TIMER#MILESTONE#DOCS_REQUEST", eventId: timerTurnEventId("MILESTONE", event.eventId), eventAtSim: event.eventAtSim }),
    ]);
    expect((await world.connector.timers.getTimer(OPERATION, "TIMER#MILESTONE#DOCS_REQUEST"))).toMatchObject({ status: "FIRED", firedBy: "CLOCK" });
    const audit = await world.connector.audit.listByOperation(OPERATION);
    expect(audit.filter((row) => row.action === "MILESTONE_FIRED")).toHaveLength(1);
  });

  it("a repeated event of a fired milestone does nothing (one turn, one audit row)", async () => {
    const world = await timeWorld();
    const event = await fireMilestone(world, "FOLLOWUP");
    await handlersOf(world).fireTimer(event, world.workerContext());
    expect(world.enqueued).toHaveLength(1);
    expect((await world.connector.audit.listByOperation(OPERATION)).filter((row) => row.action === "MILESTONE_FIRED")).toHaveLength(1);
  });

  it("[FL-064] a firing with an old version is ignored and audited: the timer and the queue stay as they were", async () => {
    const world = await timeWorld();
    await world.timer("MILESTONE", "FOLLOWUP", AT.FOLLOWUP);
    const stale = await timerEventFor(world, "TIMER#MILESTONE#FOLLOWUP", "SCHEDULER");
    await world.connector.timers.rescheduleTimer({ operationId: OPERATION, timerKey: "TIMER#MILESTONE#FOLLOWUP", dueAtSim: "2026-10-16T10:00:00-03:00", reason: "ETA_CHANGE" });
    await handlersOf(world).fireTimer(stale, world.workerContext());
    const timer = await world.connector.timers.getTimer(OPERATION, "TIMER#MILESTONE#FOLLOWUP");
    expect(timer).toMatchObject({ status: "SCHEDULED", version: 2 });
    expect(world.enqueued).toHaveLength(0);
    const audit = await world.connector.audit.listByOperation(OPERATION);
    expect(audit.find((row) => row.action === "TIMER_STALE")?.detail).toMatchObject({ firingVersion: 1, timerVersion: 2 });
  });

  it("the actions other modules own run for their kinds; a SIM_REPLY in the queue is handed to SimMail unclaimed", async () => {
    const world = await timeWorld();
    const external: string[] = [];
    await world.timer("READER_RETRY", "dv-4471-pl-1", AT.DOCS_REQUEST);
    await world.timer("SIM_REPLY", "r1", AT.DOCS_REQUEST);
    const handlers = handlersOf(world, external);
    await handlers.fireTimer(await timerEventFor(world, "TIMER#READER_RETRY#dv-4471-pl-1"), world.workerContext());
    await handlers.fireTimer(await timerEventFor(world, "TIMER#SIM_REPLY#r1"), world.workerContext());
    expect(external).toEqual(["READER_RETRY"]);
    expect(world.handoffs).toEqual([expect.objectContaining({ timerKey: "TIMER#SIM_REPLY#r1" })]);
    expect((await world.connector.timers.getTimer(OPERATION, "TIMER#SIM_REPLY#r1")).status).toBe("SCHEDULED");
  });
});
