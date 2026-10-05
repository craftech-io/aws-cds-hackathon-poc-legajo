import { describe, expect, it } from "vitest";
import { turnEventId } from "../adapter";
import { processWhatsAppEvent } from "./inbound";
import { moveToOperation } from "../../turns/routed";
import { activeOperationOf, openOperationsOf } from "./routing";
import { CLOCK, REAL_NOW, type WaWorld, addOperation, simEvent, waWorld } from "./testing";

const TEXT_WAMID = "wamid.SIM.01JAB3C4D5E6F7G8H9J0TEXT01";

/** Norpampa with a second open operation whose ETA is later than 4471's (22/10), so 4471 is the anchor. */
async function twoOperations(): Promise<WaWorld> {
  const world = await waWorld();
  await addOperation(world.stores, { operationNumber: "4476", eta: "2026-10-29T10:00:00-03:00" });
  return world;
}

async function messagesOf(world: WaWorld, operationId: string) {
  return world.stores.connector.conversations.listMessages(operationId, { direction: "IN" });
}

async function choose(world: WaWorld, row: number, wamid: string) {
  const offer = world.replies.find((reply) => reply.kind === "OPERATION_CHOICE");
  const nonce = offer?.list?.rows[row]?.nonce ?? "";
  return processWhatsAppEvent(simEvent({ type: "list_reply", nonce, title: offer?.list?.rows[row]?.title ?? "" }, { wamid }), world.deps);
}

describe("[FL-019] an importer with two open operations", () => {
  it("[FL-019] free text of a quiet chat is a turn in the anchor, with no list (ADR-0017)", async () => {
    const world = await twoOperations();
    const summary = await processWhatsAppEvent(simEvent({ type: "text", text: "¿Ya llegó lo del proveedor?" }, { wamid: TEXT_WAMID }), world.deps);
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "TURN", operationId: "op-4471" });
    expect(world.replies).toEqual([]);
    const [original] = await messagesOf(world, "op-4471");
    expect(world.events).toEqual([expect.objectContaining({ type: "AGENT_TURN", trigger: "IMPORTER_MESSAGE", operationId: "op-4471", messageId: original?.messageId, eventId: turnEventId("IMPORTER_MESSAGE", TEXT_WAMID) })]);
    expect(await messagesOf(world, "op-4476")).toEqual([]);
  });

  it("[FL-019] a moved message runs one more turn in the target, never moves again, and makes the chat about it", async () => {
    const world = await twoOperations();
    await processWhatsAppEvent(simEvent({ type: "text", text: "¿Y la 4476?" }, { wamid: TEXT_WAMID }), world.deps);
    const [original] = await messagesOf(world, "op-4471");
    const operation = await world.stores.connector.operations.getOperation("op-4471");
    const sink = { enqueue: async (event: unknown) => void world.events.push(event as never) };
    const log = { info: () => undefined, warn: () => undefined } as never;
    const moved = await moveToOperation(world.stores.connector, { sink: sink as never, log }, { operation, messageId: original?.messageId ?? "", eventAtSim: original?.sentAtSim ?? "", targetId: "op-4476" });
    const [copy] = await messagesOf(world, "op-4476");
    expect(copy).toMatchObject({ messageId: moved?.messageId, body: "¿Y la 4476?", interactive: { routedFrom: { operationId: "op-4471", messageId: original?.messageId } } });
    expect(world.events.at(-1)).toMatchObject({ trigger: "IMPORTER_MESSAGE", operationId: "op-4476", messageId: copy?.messageId, eventId: turnEventId("IMPORTER_MESSAGE", `${TEXT_WAMID}#to#op-4476`) });
    const target = await world.stores.connector.operations.getOperation("op-4476");
    expect(await moveToOperation(world.stores.connector, { sink: sink as never, log }, { operation: target, messageId: copy?.messageId ?? "", eventAtSim: copy?.sentAtSim ?? "", targetId: "op-4471" })).toBeUndefined();
    const open = await openOperationsOf(world.stores.connector, { firmId: "firm-delta", importerId: "imp-norpampa", clockId: CLOCK });
    expect((await activeOperationOf(world.stores.connector, "imp-norpampa", open, new Date(REAL_NOW)))?.operationId).toBe("op-4476");
  });

  it("[FL-019] the active operation ignores the system's choice lists and anything older than 24 h", async () => {
    const operations = [{ operationId: "op-4471" }, { operationId: "op-4476" }] as never[];
    const now = new Date("2026-10-14T12:00:00.000Z");
    const message = (operationId: string, sentAtReal: string, kind?: string) => ({ operationId, sentAtReal, ...(kind === undefined ? {} : { kind }) });
    const data = (messages: unknown[]) => ({ conversations: { listCounterpartMessages: async () => messages } }) as never;
    expect((await activeOperationOf(data([message("op-4476", "2026-10-14T11:00:00.000Z"), message("op-4471", "2026-10-14T11:30:00.000Z", "OPERATION_CHOICE")]), "imp-norpampa", operations, now))?.operationId).toBe("op-4476");
    expect((await activeOperationOf(data([message("op-4476", "2026-10-12T11:00:00.000Z")]), "imp-norpampa", operations, now))?.operationId).toBe("op-4471");
    expect((await activeOperationOf(data([message("op-4999", "2026-10-14T11:00:00.000Z")]), "imp-norpampa", operations, now))?.operationId).toBe("op-4471");
  });

  it("[FL-019] a PDF of an importer with two operations waits for the choice, then goes to the chosen intake", async () => {
    const world = await twoOperations();
    const key = "sim/msg-01JAB3C4D5E6F7G8H9J0KMNPQR/1.pdf";
    world.media.objects.set(key, { sizeBytes: 300_000, contentType: "application/pdf" });
    await processWhatsAppEvent(simEvent({ type: "document", mediaRef: `sim-media:${key}` }, { wamid: TEXT_WAMID }), world.deps);
    expect(world.replies.map((reply) => reply.kind)).toEqual(["OPERATION_CHOICE"]);
    expect(await world.stores.connector.runtime.getIdempotency("WA_MEDIA", key)).toBeUndefined();
    await choose(world, 1, "wamid.SIM.CHOICE1");
    expect(world.events.filter((event) => event.type === "AGENT_TURN")).toEqual([]);
    expect((await world.stores.connector.runtime.getIdempotency("WA_MEDIA", key))?.result).toMatchObject({ operationId: "op-4476", objectKey: key });
    expect((await world.stores.connector.world.listPending(CLOCK)).scans).toMatchObject([{ objectKey: key, operationId: "op-4476" }]);
  });
});

describe("routing to the open operations", () => {
  it("a released operation is not open: its importer's text goes straight to the other one", async () => {
    const world = await twoOperations();
    await world.stores.connector.operations.recordDispatch({ operationId: "op-4471", status: "LIBERADO", occurredAtSim: "2026-10-14T12:00:00-03:00" });
    const summary = await processWhatsAppEvent(simEvent({ type: "text", text: "Hola" }), world.deps);
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "TURN", operationId: "op-4476" });
    expect(world.replies).toEqual([]);
  });

  it("an importer without open operations is audited and nothing is written", async () => {
    const world = await waWorld();
    await world.stores.connector.operations.recordDispatch({ operationId: "op-4471", status: "LIBERADO", occurredAtSim: "2026-10-14T12:00:00-03:00" });
    const summary = await processWhatsAppEvent(simEvent({ type: "text", text: "Hola" }), world.deps);
    expect(summary.records[0]?.messages[0]?.outcome).toBe("NO_OPEN_OPERATION");
    expect(await messagesOf(world, "op-4471")).toEqual([]);
    expect((await world.stores.connector.audit.listByDecision("firm-delta", "DENY")).map((decision) => [decision.action, decision.atReal])).toEqual([["NO_OPEN_OPERATION", REAL_NOW]]);
  });
});
