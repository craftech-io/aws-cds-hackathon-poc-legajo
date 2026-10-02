import { describe, expect, it } from "vitest";
import type { SystemReplyRequest } from "../channels/whatsapp/ports";
import { REAL_NOW, simEvent, waWorld } from "../channels/whatsapp/testing";
import { createLogger } from "../lib/log";
import { THU_10_AR, outboundWorld } from "../outbound/testing";
import { createInboundWhatsAppHandler, pipelineSystemReplies } from "./inbound-whatsapp";

const OPERATION = "op-4471";

function replyRequest(inboundId: string, overrides: Partial<SystemReplyRequest> = {}): SystemReplyRequest {
  return {
    kind: "REPLY",
    textKey: "rateLimited",
    body: "Recibimos muchos mensajes seguidos. Te respondemos en un rato.",
    operationId: OPERATION,
    importerId: "imp-norpampa",
    firmId: "firm-delta",
    clockId: "GLOBAL#firm-delta",
    messageId: "msg-sysreply0001",
    inReplyTo: { messageId: inboundId, wamid: "wamid.SIM.01JAB3C4D5E6F7G8H9J0KMNPQR" },
    atSim: THU_10_AR,
    buttons: [],
    ...overrides,
  };
}

describe("InboundWhatsApp entry", () => {
  it("[FL-034] runs the adapter over the simulator's signed envelope and answers its summary", async () => {
    const world = await waWorld();
    const handler = createInboundWhatsAppHandler(() => world.deps, () => world.deps.log);
    const summary = await handler(simEvent({ type: "text", text: "Hola, ¿qué falta?" }));
    expect(summary.records).toMatchObject([{ accepted: true, simulated: true }]);
    expect(world.events.map((event) => [event.type, event.type === "AGENT_TURN" ? event.trigger : undefined])).toEqual([["AGENT_TURN", "IMPORTER_MESSAGE"]]);
    const again = await handler(simEvent({ type: "text", text: "Hola, ¿qué falta?" }));
    expect(again.records).toMatchObject([{ accepted: true }]);
    expect(world.events).toHaveLength(1);
  });

  it("rejects an envelope that is not signed by the simulator, without any effect", async () => {
    const world = await waWorld();
    const handler = createInboundWhatsAppHandler(() => world.deps, () => world.deps.log);
    const forged = simEvent({ type: "text", text: "hola" }) as { Records: Array<{ Sns: { MessageAttributes?: Record<string, unknown>; Message: string } }> };
    const record = forged.Records[0];
    if (record !== undefined) record.Sns.Message = record.Sns.Message.replace("hola", "chau");
    const summary = await handler(forged);
    expect(summary.records).toMatchObject([{ accepted: false }]);
    expect(world.events).toEqual([]);
  });
});

describe("InboundWhatsApp fixed replies through the outbound pipeline", () => {
  it("a REPLY of copy/ goes out with author SYSTEM, policy decided and audited", async () => {
    const world = await outboundWorld();
    const inbound = await world.inbound("Hola", THU_10_AR);
    const replies = pipelineSystemReplies(world.deps, createLogger({ level: "warn", sink: () => undefined, now: () => new Date(REAL_NOW) }));
    expect(await replies.reply(replyRequest(inbound))).toEqual({ status: "SENT" });
    const message = await world.stores.connector.conversations.getMessage(OPERATION, "msg-sysreply0001");
    expect(message).toMatchObject({ direction: "OUT", kind: "REPLY", author: "SYSTEM", status: "DELIVERED" });
    expect(await world.stores.connector.audit.findAllowForMessage(OPERATION, "msg-sysreply0001")).toBeDefined();
    expect(await replies.reply(replyRequest(inbound))).toEqual({ status: "SENT" });
    expect((await world.stores.connector.conversations.listMessages(OPERATION, { direction: "OUT" })).filter((row) => row.messageId === "msg-sysreply0001")).toHaveLength(1);
  });

  it("OPERATION_CHOICE goes out as the interactive list the adapter built, with its nonces", async () => {
    const world = await outboundWorld();
    const inbound = await world.inbound("Hola, mando el certificado", THU_10_AR);
    const replies = pipelineSystemReplies(world.deps, createLogger({ level: "warn", sink: () => undefined, now: () => new Date(REAL_NOW) }));
    const rows = [
      { nonce: "nonce-row-0001", title: "Operación 4471", description: "Qingdao Bluewave · arribo 22/10", operationId: OPERATION },
      { nonce: "nonce-row-0002", title: "Operación 4483", description: "Santos Verde · arribo 25/10", operationId: "op-4483" },
    ];
    const request = replyRequest(inbound, {
      kind: "OPERATION_CHOICE",
      textKey: "operationChoice",
      body: "¿De qué operación es tu mensaje?",
      messageId: "msg-syschoice001",
      list: { buttonTitle: "Elegir operación", rows },
      buttons: rows.map((row) => ({ action: "CHOOSE_OPERATION", title: row.title, nonce: row.nonce })),
    });
    expect(await replies.reply(request)).toEqual({ status: "SENT" });
    const message = await world.stores.connector.conversations.getMessage(OPERATION, "msg-syschoice001");
    expect(message).toMatchObject({ kind: "OPERATION_CHOICE", author: "SYSTEM" });
    expect(message?.buttons.map((button) => button.nonce)).toEqual(["nonce-row-0001", "nonce-row-0002"]);
  });
});
