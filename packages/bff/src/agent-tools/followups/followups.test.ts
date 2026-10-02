import { describe, expect, it } from "vitest";
import { CLOCK, START_SIM } from "../../connector/testing";
import { OPERATION } from "../common/testing";
import { handlersOf, timeWorld, timerEventFor } from "../../milestones/testing";
import { followupsWorld } from "./testing";

const at = (iso: string) => new Date(iso).getTime();

async function schedule(world: Awaited<ReturnType<typeof followupsWorld>>, input: Record<string, unknown>) {
  const turn = await world.openTurn("SUPPLIER_EMAIL");
  return world.target.invoke("schedule_followup", { sessionToken: turn.token, ...input });
}

describe("schedule_followup [FL-027]", () => {
  it("[FL-027] the supplier's promise: a FOLLOWUP_DUE timer inside its business hours, no schedule in a paused world", async () => {
    const world = await followupsWorld();
    const answer = await schedule(world, { party: "SUPPLIER", atSim: "2026-10-15T10:00:00+08:00", reason: "PROMISED_BY_SUPPLIER" });
    expect(answer).toMatchObject({ ok: true, adjustedBy: [], scheduledForText: "Oct 15, 10:00 (Asia/Shanghai)" });
    const { followupId, scheduledForSim } = answer as unknown as { followupId: string; scheduledForSim: string };
    expect(scheduledForSim).toBe("2026-10-15T10:00:00+08:00");
    const timer = await world.stores.connector.timers.getTimer(OPERATION, `TIMER#FOLLOWUP_DUE#${followupId}`);
    expect(timer).toMatchObject({ status: "SCHEDULED", reason: "PROMISED_BY_SUPPLIER", payload: { party: "SUPPLIER", reason: "PROMISED_BY_SUPPLIER" } });
    expect(world.scheduler.puts).toHaveLength(0);
  });

  it("[FL-027] outside the party's hours it moves to the next opening and says so (CP-HOURS-SUPPLIER, CP-HOURS-AR)", async () => {
    const world = await followupsWorld();
    const supplier = await schedule(world, { party: "SUPPLIER", atSim: "2026-10-17T10:00:00+08:00", reason: "PROMISED_BY_SUPPLIER" });
    expect(supplier).toMatchObject({ ok: true, adjustedBy: ["CP-HOURS-SUPPLIER"], scheduledForSim: "2026-10-19T09:00:00+08:00" });
    const importer = await schedule(world, { party: "IMPORTER", atSim: "2026-10-14T20:00:00-03:00", reason: "IMPORTER_ASKED_LATER" });
    expect(importer).toMatchObject({ ok: true, adjustedBy: ["CP-HOURS-AR"], scheduledForSim: "2026-10-15T09:00:00-03:00", scheduledForText: "15/10 09:00" });
  });

  it("[FL-027] a third open follow-up is refused, and so is one at or after the ESCALATION milestone or in the past", async () => {
    const world = await followupsWorld();
    await schedule(world, { party: "SUPPLIER", atSim: "2026-10-15T10:00:00+08:00", reason: "PROMISED_BY_SUPPLIER" });
    await schedule(world, { party: "IMPORTER", atSim: "2026-10-15T11:00:00-03:00", reason: "IMPORTER_ASKED_LATER" });
    expect(await schedule(world, { party: "IMPORTER", atSim: "2026-10-16T11:00:00-03:00", reason: "OTHER" })).toMatchObject({ ok: false, error: { code: "CONFLICT", reason: "FOLLOWUP_LIMIT" } });
    const other = await followupsWorld();
    expect(await schedule(other, { party: "IMPORTER", atSim: "2026-10-20T09:00:00-03:00", reason: "OTHER" })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "FOLLOWUP_AFTER_ESCALATION" } });
    expect(await schedule(other, { party: "IMPORTER", atSim: "2026-10-14T09:00:00-03:00", reason: "OTHER" })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "FOLLOWUP_IN_THE_PAST" } });
    expect(await schedule(other, { party: "IMPORTER", atSim: "2026-10-15T11:00:00-03:00", reason: "OTHER", operationId: "op-4472" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("[FL-027] in a running world a follow-up inside the horizon gets its schedule", async () => {
    const world = await followupsWorld();
    const clock = await world.stores.connector.world.getClock(CLOCK);
    const now = world.deps.wallClock().getTime();
    await world.stores.connector.world.updateClock(CLOCK, { mode: "RUNNING", offsetMs: at(START_SIM) - now, runningUntilReal: new Date(now + 30 * 60_000).toISOString() }, clock.version);
    await schedule(world, { party: "IMPORTER", atSim: "2026-10-14T10:50:00-03:00", reason: "IMPORTER_ASKED_LATER" });
    expect(world.scheduler.puts).toHaveLength(1);
    expect(world.scheduler.puts[0]?.at.getTime()).toBe(now + 20 * 60_000);
  });
});

describe("fire_timer of a follow-up [FL-027]", () => {
  it("[FL-027] the document already arrived: SKIPPED, no turn", async () => {
    const world = await timeWorld();
    await world.timer("FOLLOWUP_DUE", "fu-1", "2026-10-16T10:00:00+08:00", { payload: { party: "SUPPLIER", pending: [{ docType: "PACKING_LIST", version: 0 }] } });
    await world.validate("PACKING_LIST");
    await handlersOf(world).fireTimer(await timerEventFor(world, "TIMER#FOLLOWUP_DUE#fu-1"), world.workerContext());
    expect(await world.connector.timers.getTimer(OPERATION, "TIMER#FOLLOWUP_DUE#fu-1")).toMatchObject({ status: "SKIPPED", reason: "DOCUMENT_ARRIVED" });
    expect(world.enqueued).toHaveLength(0);
  });

  it("[FL-027] still missing: an AGENT_TURN(FOLLOWUP_DUE) with the timer", async () => {
    const world = await timeWorld();
    await world.timer("FOLLOWUP_DUE", "fu-1", "2026-10-16T10:00:00+08:00", { payload: { party: "SUPPLIER", pending: [{ docType: "PACKING_LIST", version: 0 }] } });
    await handlersOf(world).fireTimer(await timerEventFor(world, "TIMER#FOLLOWUP_DUE#fu-1"), world.workerContext());
    expect(world.enqueued).toEqual([expect.objectContaining({ type: "AGENT_TURN", trigger: "FOLLOWUP_DUE", timerKey: "TIMER#FOLLOWUP_DUE#fu-1" })]);
    expect((await world.connector.timers.getTimer(OPERATION, "TIMER#FOLLOWUP_DUE#fu-1")).status).toBe("FIRED");
  });
});
