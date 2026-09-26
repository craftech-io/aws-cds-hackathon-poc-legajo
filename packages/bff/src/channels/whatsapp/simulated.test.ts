import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { REFERENCE_SCOPES, referenceKey } from "../../connector/keys";
import { processWhatsAppEvent } from "./inbound";
import { type MetaMessage, toMetaMessage } from "./meta-message";
import { WhatsAppSnsEvent } from "./payloads";
import { hasValidSimSignature } from "./sim-envelope";
import { lambdaEnvelopeDelivery, sendFromPhone, tapContent } from "./simulator";
import { CLOCK, KEYS, PHONE, REAL_NOW, START_SIM, type WaWorld, waWorld } from "./testing";

const RECORD = { operationId: "op-4471", clockId: CLOCK, messageId: "msg-0a1b2c3d4e" };
const TOKEN = "Zq3v9Kf0mX2bR7wLpT4yNc8hJd1sGa6eUo5iQkVxWtY";
const TEMPLATE = toMetaMessage({
  kind: "template",
  to: PHONE,
  name: "legajo_docs_pendientes",
  params: ["Estudio Delta", "4471", "Austral Aurora", "22/10", "certificado de origen y packing list"],
  buttons: [{ uploadToken: TOKEN }, { nonce: "nonceSupplierSends000000000000001" }, { nonce: "nonceQuestion0000000000000000002" }, { nonce: "nonceOptOut000000000000000000003" }],
});

/** What the outbound pipeline does with a send: the `Message OUT` with what the transport answered. */
async function sendAndPersist(world: WaWorld, message: MetaMessage) {
  const result = await world.transport.send({ message, record: RECORD });
  await world.stores.connector.conversations.appendMessage({
    ...RECORD,
    firmId: "firm-delta",
    direction: "OUT",
    channel: "WHATSAPP",
    kind: "DOCS_REQUEST",
    counterpart: "IMPORTER",
    importerId: "imp-norpampa",
    to: PHONE,
    from: "simulated",
    body: "Hola, te escribimos desde Estudio Delta.",
    status: result.status,
    providerMessageId: result.providerMessageId,
    author: "AGENT",
    simulated: result.simulated,
    sentAtSim: START_SIM,
    sentAtReal: result.sentAtReal,
  });
  return result;
}

describe("[FL-083] the simulated transport", () => {
  it("[FL-083] validates the same Meta JSON and records sent at once and delivered a second later", async () => {
    const world = await waWorld();
    const result = await sendAndPersist(world, TEMPLATE);
    expect(result).toEqual({ providerMessageId: "wamid.SIM.OUT000001", simulated: true, status: "DELIVERED", sentAtReal: REAL_NOW });
    const events = await world.stores.connector.conversations.listMessageEvents("op-4471");
    expect(events.map((event) => [event.type, event.atReal, event.simulated, event.messageId])).toEqual([
      ["SENT", REAL_NOW, true, RECORD.messageId],
      ["DELIVERED", "2026-09-26T15:00:01.000Z", true, RECORD.messageId],
    ]);
  });

  it("[FL-083] renders a template that is only LOCAL_ONLY, and refuses one Reference does not have or a malformed message", async () => {
    const world = await waWorld();
    expect((await world.stores.connector.reference.getTemplate("legajo_docs_pendientes"))?.status).toBe("LOCAL_ONLY");
    await expect(world.transport.send({ message: TEMPLATE })).resolves.toMatchObject({ simulated: true, status: "SENT" });
    await world.stores.client.delete("Reference", referenceKey("TEMPLATE", REFERENCE_SCOPES.TEMPLATE, "legajo_docs_pendientes"));
    await expect(world.transport.send({ message: TEMPLATE })).rejects.toMatchObject({ code: "INVALID" });
    const linkPreview = { messaging_product: "whatsapp", recipient_type: "individual", to: "5491155500101", type: "text", text: { preview_url: true, body: "https://attacker.example.net" } } as unknown as MetaMessage;
    await expect(world.transport.send({ message: linkPreview })).rejects.toMatchObject({ code: "INVALID" });
    expect(await world.stores.connector.conversations.listMessageEvents("op-4471")).toEqual([]);
  });

  it("[FL-083] “marcar leído” turns the delivered messages of the importer's thread into read, through the status path", async () => {
    const world = await waWorld();
    await sendAndPersist(world, TEMPLATE);
    world.setNow("2026-09-26T15:02:00.000Z");
    expect(await world.transport.markRead("imp-norpampa")).toBe(1);
    expect((await world.stores.connector.conversations.getMessage("op-4471", RECORD.messageId))?.status).toBe("READ");
    expect((await world.stores.connector.conversations.listMessageEvents("op-4471")).map((event) => event.type)).toEqual(["SENT", "DELIVERED", "READ"]);
    expect(await world.transport.markRead("imp-norpampa")).toBe(0);
  });
});

describe("[FL-083] the phone simulator's way in", () => {
  it("[FL-083] a text on the phone becomes the same SNS envelope, signed, and enters by InboundWhatsApp", async () => {
    const world = await waWorld();
    const delivered: unknown[] = [];
    const delivery = { deliver: async (event: WhatsAppSnsEvent) => (delivered.push(event), processWhatsAppEvent(event, world.deps)) };
    const sent = await sendFromPhone({ simEnvelopeKey: KEYS.simEnvelope, delivery, realClock: world.deps.realClock }, { phoneE164: PHONE, content: { type: "text", text: "¿Qué me falta?" } });
    expect(sent.wamid).toMatch(/^wamid\.SIM\.[0-9A-HJKMNP-TV-Z]{26}$/);
    const event = WhatsAppSnsEvent.parse(delivered[0]);
    expect(hasValidSimSignature(KEYS.simEnvelope, event.Records[0] ?? ({} as never))).toBe(true);
    expect(sent.summary).toMatchObject({ records: [{ accepted: true, simulated: true, messages: [{ outcome: "TURN", operationId: "op-4471" }] }] });
    expect((await world.stores.connector.conversations.listMessages("op-4471", { direction: "IN" }))[0]).toMatchObject({ body: "¿Qué me falta?", providerMessageId: sent.wamid, simulated: true });
  });

  it("[FL-083] a tap answers with the kind of reply its message had; a URL button sends nothing", () => {
    const button = { action: "SUPPLIER_SENDS" as const, title: "Los manda el proveedor", nonce: "nonceSupplierSends000000000000001" };
    expect(tapContent({ kind: "DOCS_REQUEST", template: { name: "legajo_docs_pendientes", params: [] } }, button)).toEqual({ type: "template_reply", nonce: button.nonce, title: button.title });
    expect(tapContent({ kind: "CONTACT_CONFIRMATION" }, button)).toEqual({ type: "button_reply", nonce: button.nonce, title: button.title });
    expect(tapContent({ kind: "OPERATION_CHOICE" }, { ...button, action: "CHOOSE_OPERATION", title: "Operación 4471" })).toMatchObject({ type: "list_reply" });
    expect(() => tapContent({ kind: "DOCS_REQUEST" }, { action: "UPLOAD", title: "Subir documentos" })).toThrow(/link/);
  });

  it("[FL-083] the BFF invokes InboundWhatsApp and reads its summary; a function error is an error", async () => {
    const lambda = mockClient(LambdaClient);
    lambda.on(InvokeCommand).resolvesOnce({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ records: [] })) as never }).resolves({ StatusCode: 200, FunctionError: "Unhandled" });
    const delivery = lambdaEnvelopeDelivery({ functionName: () => "aws-cds-hackathon-poc-legajo-poc-InboundWhatsApp", client: new LambdaClient({ region: "us-east-1" }) });
    const event: WhatsAppSnsEvent = { Records: [] as never };
    expect(await delivery.deliver(event)).toEqual({ records: [] });
    expect(lambda.commandCalls(InvokeCommand)[0]?.args[0].input).toMatchObject({ FunctionName: "aws-cds-hackathon-poc-legajo-poc-InboundWhatsApp", InvocationType: "RequestResponse" });
    await expect(delivery.deliver(event)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    lambda.restore();
  });
});
