import { describe, expect, it } from "vitest";
import { FIRM, OPERATION } from "../services/operations-admin/testing";
import { consoleServiceWorld } from "./console-testing";
import { DIEGO, MARTINA, PABLO } from "./testing";

describe("conversation router", () => {
  it("[FL-067] an analyst takes the conversation from the console: control BROKER, TAKEOVER audited with the broker", async () => {
    const world = await consoleServiceWorld();
    expect(await world.caller(MARTINA).conversation.take({ operationId: OPERATION })).toEqual({ operationId: OPERATION, control: "BROKER", changed: true });
    const operation = await world.stores.connector.operations.getOperation(OPERATION);
    expect(operation.controlHistory.at(-1)).toMatchObject({ control: "BROKER", by: "BROKER:brk-delta-martina" });
    expect((await world.stores.connector.audit.listByOperation(OPERATION)).find((row) => row.action === "TAKEOVER")?.refs).toMatchObject({ brokerId: "brk-delta-martina" });
  });

  it("[FL-068] writes to the importer only after taking the conversation, through OUTBOUND_SEND signed by the broker", async () => {
    const world = await consoleServiceWorld();
    await expect(world.caller(DIEGO).conversation.send({ operationId: OPERATION, text: "Hola Lucía" })).rejects.toMatchObject({ code: "CONFLICT", cause: { reason: "CONTROL_NOT_TAKEN" } });
    await world.caller(DIEGO).conversation.take({ operationId: OPERATION });
    expect(await world.caller(DIEGO).conversation.send({ operationId: OPERATION, text: "Hola Lucía, ¿pudiste ver el packing list?" })).toMatchObject({ queued: true });
    expect(world.events.at(-1)).toMatchObject({ type: "OUTBOUND_SEND", kind: "BROKER_MESSAGE", author: "BROKER:brk-delta-diego", text: "Hola Lucía, ¿pudiste ver el packing list?" });
    await world.caller(DIEGO).conversation.send({ operationId: OPERATION, template: "legajo_escalado" });
    expect(world.events.at(-1)).toMatchObject({ template: { name: "legajo_escalado", params: ["4471", "Estudio Delta"] } });
    await expect(world.caller(DIEGO).conversation.send({ operationId: OPERATION, template: "legajo_aprobado" })).rejects.toMatchObject({ code: "BAD_REQUEST", cause: { reason: "TEMPLATE_NOT_FOR_BROKER" } });
  });

  it("[FL-070] gives the conversation back to the agent with AGENT_TURN(BROKER_RELEASED)", async () => {
    const world = await consoleServiceWorld();
    await world.caller(DIEGO).conversation.take({ operationId: OPERATION });
    expect(await world.caller(DIEGO).conversation.release({ operationId: OPERATION })).toMatchObject({ control: "AGENT", changed: true });
    expect(world.events).toMatchObject([{ type: "AGENT_TURN", trigger: "BROKER_RELEASED", operationId: OPERATION, firmId: FIRM }]);
  });

  it("refuses another firm's operation (403 CROSS_FIRM) and an undeclared field", async () => {
    const world = await consoleServiceWorld();
    await expect(world.caller(PABLO).conversation.take({ operationId: OPERATION })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(world.caller(DIEGO).conversation.take({ operationId: OPERATION, firmId: FIRM } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await world.stores.connector.operations.getOperation(OPERATION)).control).toBe("AGENT");
  });
});
