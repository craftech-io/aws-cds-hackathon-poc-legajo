import { describe, expect, it } from "vitest";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { FIRM, OPERATION, consoleCaller, serviceWorld } from "../operations-admin/testing";
import { brokerSendHandler, importerDeadlineText, shortDateTimeEsAR } from "./broker-send";
import { releaseConversationHandler, takeConversationHandler } from "./control";

describe("take_conversation [FL-067]", () => {
  it("[FL-067] the firm takes the conversation: control BROKER dated in its history, TAKEOVER audited, intervention counted", async () => {
    const world = await serviceWorld();
    const answer = unwrapDirect(await takeConversationHandler(world.deps)({ caller: consoleCaller(FIRM, "ANALYST"), operationId: OPERATION }));
    expect(answer).toEqual({ ok: true, operationId: OPERATION, control: "BROKER", changed: true });
    const operation = await world.stores.connector.operations.getOperation(OPERATION);
    expect(operation.controlHistory.at(-1)).toMatchObject({ control: "BROKER", by: "BROKER:brk-delta-martina" });
    expect((await world.stores.connector.audit.listByOperation(OPERATION)).map((row) => row.action)).toEqual(["TAKEOVER"]);
    const kpi = await world.stores.connector.metrics.getKpi({ firmId: FIRM, source: "WORLD", clockId: operation.clockId, operationId: OPERATION });
    expect(kpi).toMatchObject({ humanActions: 1, interventions: 1 });
    expect(unwrapDirect(await takeConversationHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION })).changed).toBe(false);
  });
});

describe("release_conversation [FL-070]", () => {
  it("[FL-070] hands the operation back to the agent with an AGENT_TURN(BROKER_RELEASED)", async () => {
    const world = await serviceWorld();
    unwrapDirect(await takeConversationHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION }));
    const answer = unwrapDirect(await releaseConversationHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION }));
    expect(answer).toMatchObject({ control: "AGENT", changed: true });
    expect(world.events).toMatchObject([{ type: "AGENT_TURN", trigger: "BROKER_RELEASED", operationId: OPERATION, eventId: expect.stringMatching(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/) }]);
    expect(unwrapDirect(await releaseConversationHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION })).changed).toBe(false);
    expect(world.events).toHaveLength(1);
  });
});

describe("broker_send [FL-068]", () => {
  it("[FL-068] needs the conversation taken first", async () => {
    const world = await serviceWorld();
    expect(await brokerSendHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION, text: "Hola Lucía" })).toMatchObject({ ok: false, error: { code: "CONFLICT", reason: "CONTROL_NOT_TAKEN" } });
    expect(world.events).toEqual([]);
  });

  it("[FL-068] queues OUTBOUND_SEND BROKER_MESSAGE signed by the broker; the pipeline decides the window", async () => {
    const world = await serviceWorld();
    unwrapDirect(await takeConversationHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION }));
    const answer = unwrapDirect(await brokerSendHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION, text: "Hola Lucía, ¿pudiste ver el packing list?" }));
    expect(answer).toMatchObject({ queued: true });
    expect(world.events.at(-1)).toMatchObject({ type: "OUTBOUND_SEND", kind: "BROKER_MESSAGE", author: "BROKER:brk-delta-diego", channel: "WHATSAPP", text: "Hola Lucía, ¿pudiste ver el packing list?", eventId: answer.eventId });
  });

  it("[FL-068] outside the window, the firm's templates with their parameters filled from the operation", async () => {
    const world = await serviceWorld();
    unwrapDirect(await takeConversationHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION }));
    const send = brokerSendHandler(world.deps);
    unwrapDirect(await send({ caller: consoleCaller(), operationId: OPERATION, template: "legajo_recordatorio" }));
    expect(world.events.at(-1)).toMatchObject({ template: { name: "legajo_recordatorio", params: ["4471", "factura comercial, packing list y certificado de origen", "19/10 10:00"] } });
    unwrapDirect(await send({ caller: consoleCaller(), operationId: OPERATION, template: "legajo_escalado" }));
    expect(world.events.at(-1)).toMatchObject({ template: { name: "legajo_escalado", params: ["4471", "Estudio Delta"] } });
    expect(await send({ caller: consoleCaller(), operationId: OPERATION, template: "legajo_aprobado" })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "TEMPLATE_NOT_FOR_BROKER" } });
  });

  it("formats the importer's deadline in Argentina's time", () => {
    expect(importerDeadlineText("2026-10-22T08:00:00-03:00")).toBe("19/10 10:00");
    expect(shortDateTimeEsAR("2026-10-16T13:05:00.000Z")).toBe("16/10 10:05");
  });
});
