import { describe, expect, it } from "vitest";
import { OPERATION, handlersOf, timeWorld, timerEventFor } from "./testing";
import { AT_RISK_ACTION } from "./deps";

const ARRIVAL_AT = "2026-10-22T08:00:00-03:00";

async function fireArrival(world: Awaited<ReturnType<typeof timeWorld>>): Promise<void> {
  await world.timer("MILESTONE", "ARRIVAL", ARRIVAL_AT);
  await handlersOf(world).fireTimer(await timerEventFor(world, "TIMER#MILESTONE#ARRIVAL"), world.workerContext());
}

describe("ARRIVAL milestone [FL-071]", () => {
  it("[FL-071] with documents missing: at risk, risk recalculated with the assumptions, no new message after the escalation, no turn", async () => {
    const world = await timeWorld();
    await world.validate("COMMERCIAL_INVOICE");
    const operation = await world.connector.operations.getOperation(OPERATION);
    await world.connector.operations.openEscalation({ operationId: OPERATION, firmId: operation.firmId, clockId: operation.clockId, reason: "MISSING_AT_ETA_48H", summary: "x", openedAtSim: "2026-10-20T08:00:00-03:00", openedBy: "SYSTEM", emailSent: true, notifyImporter: true });
    await fireArrival(world);
    const audit = await world.connector.audit.listByOperation(OPERATION);
    const mark = audit.find((row) => row.action === AT_RISK_ACTION);
    // 14/10 10:30 → 22/10 08:00: 8 days without the documents; 5 free days → 3 to 8 days at risk.
    expect(mark?.detail).toMatchObject({ atRisk: true, missing: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"], daysAtRisk: { min: 3, max: 8 }, estimatedCostUsd: { min: 480, max: 1440 } });
    expect(String(mark?.detail?.["text"])).toContain("supuesto");
    expect((await world.connector.operations.getOperation(OPERATION)).atRisk).toBe(true);
    expect(world.sent).toHaveLength(0);
    expect(world.enqueued).toHaveLength(0);
    expect(await world.connector.timers.getTimer(OPERATION, "TIMER#MILESTONE#ARRIVAL")).toMatchObject({ status: "FIRED" });
  });

  it("[FL-071] with no escalation before (the clock went straight past ETA − 48 h): the deterministic escalation tells the firm", async () => {
    const world = await timeWorld();
    await fireArrival(world);
    const [escalation] = await world.connector.operations.listEscalations(OPERATION);
    expect(escalation?.reason).toBe("MISSING_AT_ETA_48H");
    expect(world.sent.map((sent) => sent.request.channel)).toEqual(["EMAIL", "WHATSAPP"]);
  });

  it("[FL-071] a complete dossier is not marked", async () => {
    const world = await timeWorld();
    await world.validate("COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN");
    await fireArrival(world);
    const audit = await world.connector.audit.listByOperation(OPERATION);
    expect(audit.some((row) => row.action === AT_RISK_ACTION)).toBe(false);
    expect((await world.connector.operations.getOperation(OPERATION)).atRisk).toBeUndefined();
    expect((await world.connector.timers.getTimer(OPERATION, "TIMER#MILESTONE#ARRIVAL")).status).toBe("SKIPPED");
  });
});
