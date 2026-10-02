import { describe, expect, it } from "vitest";
import type { FirmEmailSend, WhatsAppSend } from "../outbound/types";
import { OPERATION, handlersOf, sentMessage, timeWorld, timerEventFor } from "./testing";

const ESCALATION_AT = "2026-10-20T08:00:00-03:00";

describe("ESCALATION milestone, ETA − 48 h [FL-066]", () => {
  it("[FL-066] with documents missing: MISSING_AT_ETA_48H, the firm's email with what was tried and the labelled risk, legajo_escalado through the pipeline, no turn", async () => {
    const world = await timeWorld();
    await world.validate("COMMERCIAL_INVOICE");
    await sentMessage(world, { messageId: "msg-out1", channel: "WHATSAPP", kind: "DOCS_REQUEST", sentAtSim: "2026-10-15T10:00:00-03:00" });
    await sentMessage(world, { messageId: "msg-out2", channel: "EMAIL", kind: "REMINDER", sentAtSim: "2026-10-17T10:05:00-03:00" });
    await world.timer("MILESTONE", "ESCALATION", ESCALATION_AT);
    await handlersOf(world).fireTimer(await timerEventFor(world, "TIMER#MILESTONE#ESCALATION"), world.workerContext());

    const [escalation] = await world.connector.operations.listEscalations(OPERATION);
    expect(escalation).toMatchObject({ reason: "MISSING_AT_ETA_48H", status: "OPEN", openedBy: "SYSTEM", emailSent: true, notifyImporter: true });
    const email = world.sent.find((sent) => sent.request.channel === "EMAIL")?.request as FirmEmailSend;
    expect(email).toMatchObject({ counterpart: "FIRM", kind: "ESCALATION", author: "SYSTEM", textSource: "CODE", trigger: "MILESTONE" });
    expect(new Date(email.eventAtSim).getTime()).toBe(new Date(ESCALATION_AT).getTime());
    expect(email.text).toContain("supuesto");
    expect(email.text).toContain("Fuentes secundarias no verificadas");
    expect(email.text).toContain("15/10 10:00");
    expect(email.text).toContain("17/10 10:05");
    expect(email.text).toContain("https://legajo.demo.craftech.io/app/operations/op-4471");
    const notice = world.sent.find((sent) => sent.request.channel === "WHATSAPP")?.request as WhatsAppSend;
    expect(notice).toMatchObject({ kind: "ESCALATION_NOTICE", author: "SYSTEM", template: { name: "legajo_escalado", params: ["4471", "Estudio Delta"] } });
    expect(world.enqueued).toHaveLength(0);
    expect(await world.connector.timers.getTimer(OPERATION, "TIMER#MILESTONE#ESCALATION")).toMatchObject({ status: "FIRED" });
  });

  it("[FL-066] without anything missing: SKIPPED, no escalation, nothing sent", async () => {
    const world = await timeWorld();
    await world.validate("COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN");
    await world.timer("MILESTONE", "ESCALATION", ESCALATION_AT);
    await handlersOf(world).fireTimer(await timerEventFor(world, "TIMER#MILESTONE#ESCALATION"), world.workerContext());
    expect(await world.connector.operations.listEscalations(OPERATION)).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
    expect((await world.connector.timers.getTimer(OPERATION, "TIMER#MILESTONE#ESCALATION")).status).toBe("SKIPPED");
  });

  it("[FL-066] a notice the policy defers is still an escalation with its email to the firm", async () => {
    const world = await timeWorld();
    await world.timer("MILESTONE", "ESCALATION", ESCALATION_AT);
    world.sendStatus = "DEFERRED";
    await handlersOf(world).fireTimer(await timerEventFor(world, "TIMER#MILESTONE#ESCALATION"), world.workerContext());
    const [escalation] = await world.connector.operations.listEscalations(OPERATION);
    expect(escalation?.emailSent).toBe(false);
    const audit = await world.connector.audit.listByOperation(OPERATION);
    expect(audit.find((row) => row.action === "MILESTONE_FIRED")?.detail).toMatchObject({ firmEmail: "DEFERRED", importerNotice: "DEFERRED" });
  });
});
