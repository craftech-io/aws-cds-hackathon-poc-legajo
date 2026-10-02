import { describe, expect, it } from "vitest";
import { OPERATION, handlersOf, timeWorld, timerEventFor } from "../milestones/testing";

const DUE = "2026-10-16T10:00:00-03:00";

describe("TIMER#CONTACT_CHECK: NO_VALID_CONTACT", () => {
  it("one simulated day after a bounce with no confirmed ACTIVE contact: the escalation and its email to the firm", async () => {
    const world = await timeWorld();
    await world.connector.parties.transitionContact({ supplierId: "sup-qingdao", contactId: "ctc-qingdao-1", to: "BOUNCED", atSim: "2026-10-15T10:00:00-03:00", by: "SYSTEM" });
    await world.timer("CONTACT_CHECK", "ctc-qingdao-1", DUE);
    await handlersOf(world).fireTimer(await timerEventFor(world, "TIMER#CONTACT_CHECK#ctc-qingdao-1"), world.workerContext());
    const [escalation] = await world.connector.operations.listEscalations(OPERATION);
    expect(escalation).toMatchObject({ reason: "NO_VALID_CONTACT", emailSent: true });
    expect(world.sent.map((sent) => sent.request.channel)).toEqual(["EMAIL"]);
    expect((await world.connector.timers.getTimer(OPERATION, "TIMER#CONTACT_CHECK#ctc-qingdao-1")).status).toBe("FIRED");
  });

  it("a confirmed ACTIVE contact by then: SKIPPED, nothing sent", async () => {
    const world = await timeWorld();
    await world.timer("CONTACT_CHECK", "ctc-qingdao-1", DUE);
    await handlersOf(world).fireTimer(await timerEventFor(world, "TIMER#CONTACT_CHECK#ctc-qingdao-1"), world.workerContext());
    expect(await world.connector.timers.getTimer(OPERATION, "TIMER#CONTACT_CHECK#ctc-qingdao-1")).toMatchObject({ status: "SKIPPED", reason: "CONTACT_CONFIRMED" });
    expect(world.sent).toHaveLength(0);
  });
});
