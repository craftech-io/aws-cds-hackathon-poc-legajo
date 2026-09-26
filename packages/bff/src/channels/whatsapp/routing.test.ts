import { describe, expect, it } from "vitest";
import { importerEsAR } from "../../copy/es-AR";
import { turnEventId } from "../adapter";
import { processWhatsAppEvent } from "./inbound";
import { etaRowText } from "./routing";
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
  it("[FL-019] free text gets the deterministic OPERATION_CHOICE list and no turn", async () => {
    const world = await twoOperations();
    const summary = await processWhatsAppEvent(simEvent({ type: "text", text: "¿Ya llegó lo del proveedor?" }, { wamid: TEXT_WAMID }), world.deps);
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "OPERATION_CHOICE", operationId: "op-4471" });
    expect(world.events).toEqual([]);
    const [offer] = world.replies;
    expect(offer).toMatchObject({ kind: "OPERATION_CHOICE", textKey: "operationChoice", body: importerEsAR.operationChoice.body, operationId: "op-4471" });
    expect(offer?.list?.buttonTitle).toBe("Elegir operación");
    expect(offer?.list?.rows.map((row) => [row.operationId, row.title])).toEqual([
      ["op-4471", "Operación 4471"],
      ["op-4476", "Operación 4476"],
    ]);
    expect(offer?.list?.rows[1]?.description).toBe(`Qingdao Bluewave Textiles Co., Ltd. · arribo estimado ${etaRowText("2026-10-29T10:00:00-03:00")}`);
    expect(offer?.buttons.map((button) => button.action)).toEqual(["CHOOSE_OPERATION", "CHOOSE_OPERATION"]);
    for (const row of offer?.list?.rows ?? []) {
      expect(await world.stores.connector.runtime.getNonce(row.nonce)).toMatchObject({ action: "CHOOSE_OPERATION", operationId: row.operationId, importerId: "imp-norpampa", clockId: CLOCK });
    }
    expect((await messagesOf(world, "op-4471")).map((message) => message.body)).toEqual(["¿Ya llegó lo del proveedor?"]);
    expect(await messagesOf(world, "op-4476")).toEqual([]);
  });

  it("[FL-019] the choice runs one turn in the chosen operation, with the original text", async () => {
    const world = await twoOperations();
    await processWhatsAppEvent(simEvent({ type: "text", text: "¿Ya llegó lo del proveedor?" }, { wamid: TEXT_WAMID }), world.deps);
    const summary = await choose(world, 1, "wamid.SIM.CHOICE1");
    expect(summary.records[0]?.messages[0]).toMatchObject({ outcome: "CHOICE_APPLIED", operationId: "op-4476" });
    const [original] = await messagesOf(world, "op-4471");
    const chosen = await messagesOf(world, "op-4476");
    const copy = chosen.find((message) => message.interactive?.routedFrom !== undefined);
    expect(copy).toMatchObject({ body: "¿Ya llegó lo del proveedor?", interactive: { routedFrom: { operationId: "op-4471", messageId: original?.messageId } } });
    expect(copy?.providerMessageId).toBeUndefined();
    expect(chosen.find((message) => message.providerMessageId === "wamid.SIM.CHOICE1")).toMatchObject({ interactive: { buttonAction: "CHOOSE_OPERATION", buttonResolved: true } });
    expect(world.events).toEqual([
      { type: "AGENT_TURN", eventId: turnEventId("IMPORTER_MESSAGE", TEXT_WAMID), trigger: "IMPORTER_MESSAGE", operationId: "op-4476", clockId: CLOCK, firmId: "firm-delta", messageId: copy?.messageId, eventAtSim: "2026-10-14T13:30:00.000Z", intakeEventIds: [] },
    ]);
  });

  it("[FL-019] choosing the anchor needs no copy; the list is used up, so a later row never runs a second turn", async () => {
    const world = await twoOperations();
    await processWhatsAppEvent(simEvent({ type: "text", text: "Consulta" }, { wamid: TEXT_WAMID }), world.deps);
    await choose(world, 0, "wamid.SIM.CHOICE1");
    const [original] = (await messagesOf(world, "op-4471")).filter((message) => message.providerMessageId === TEXT_WAMID);
    expect(world.events).toEqual([expect.objectContaining({ operationId: "op-4471", messageId: original?.messageId, eventId: turnEventId("IMPORTER_MESSAGE", TEXT_WAMID) })]);
    for (const [row, wamid] of [[1, "wamid.SIM.CHOICE2"], [0, "wamid.SIM.CHOICE3"]] as const) {
      expect((await choose(world, row, wamid)).records[0]?.messages[0]?.outcome).not.toBe("CHOICE_APPLIED");
    }
    // Nothing reached the other operation: no turn, so nothing of it is left in flight either.
    expect(world.events.filter((event) => event.type === "AGENT_TURN" && event.operationId === "op-4476")).toEqual([]);
    const refusals = await Promise.all(["op-4471", "op-4476"].map((operationId) => world.stores.connector.audit.listByOperation(operationId)));
    expect(refusals.flat().filter((decision) => decision.action === "NONCE_USED")).toHaveLength(2);
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
