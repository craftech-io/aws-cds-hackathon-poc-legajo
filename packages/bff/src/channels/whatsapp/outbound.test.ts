import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { importerEsAR } from "../../copy/es-AR";
import { META_API_VERSION } from "./config";
import { liveWhatsAppTransport } from "./live-transport";
import { type WaOutbound, noncesOf, systemReplyMessage, toMetaMessage } from "./meta-message";
import { PHONE, OTHER_PHONE, templateItems, waWorld } from "./testing";

const PHONE_NUMBER_ID = "phone-number-id-0123456789abcdef0123456789abcdef";
const TOKEN = "Zq3v9Kf0mX2bR7wLpT4yNc8hJd1sGa6eUo5iQkVxWtY";
const sdk = mockClient(SocialMessagingClient);
afterEach(() => sdk.reset());

function expected(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as unknown;
}

const DOCS_REQUEST: WaOutbound = {
  kind: "template",
  to: PHONE,
  name: "legajo_docs_pendientes",
  params: ["Estudio Delta", "4471", "Austral Aurora", "22/10", "certificado de origen y packing list"],
  buttons: [{ uploadToken: TOKEN }, { nonce: "nonceSupplierSends000000000000001" }, { nonce: "nonceQuestion0000000000000000002" }, { nonce: "nonceOptOut000000000000000000003" }],
};

async function liveTransport(options: { readonly approved?: boolean; readonly allowed?: readonly string[] } = {}) {
  const world = await waWorld();
  if (options.approved) await world.stores.seed.loadItems("Reference", templateItems("APPROVED"));
  return liveWhatsAppTransport({
    phoneNumberId: PHONE_NUMBER_ID,
    mediaBucket: "aws-cds-hackathon-poc-leg-poc-media-776805327629",
    allowedPhones: options.allowed ?? [PHONE],
    templates: world.stores.connector.reference,
    media: world.media,
    realClock: world.deps.realClock,
    client: new SocialMessagingClient({ region: "us-east-1" }),
    retry: { sleep: async () => undefined },
  });
}

function sentJson(index = 0): unknown {
  const bytes = sdk.commandCalls(SendWhatsAppMessageCommand)[index]?.args[0].input.message;
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

describe("[FL-091] the Meta JSON of every send", () => {
  it("[FL-091] template: body parameters, the URL button with the upload token and a nonce per quick reply", () => {
    const message = toMetaMessage(DOCS_REQUEST);
    expect(message).toEqual(expected("send-template.json"));
    expect(noncesOf(message)).toEqual(["nonceSupplierSends000000000000001", "nonceQuestion0000000000000000002", "nonceOptOut000000000000000000003"]);
  });

  it("[FL-091] interactive reply buttons and the operation list, with Meta's limits", () => {
    const body = importerEsAR.contactConfirmation({ maskedEmail: "s•••@sim.legajo.demo.craftech.io" });
    const buttons = [
      { id: "nonceConfirm0000000000000000001", title: "Sí, escribile" },
      { id: "nonceReject00000000000000000002", title: "No" },
      { id: "nonceOther000000000000000000003", title: "Otro contacto" },
    ];
    expect(toMetaMessage({ kind: "buttons", to: PHONE, body, buttons })).toEqual(expected("send-buttons.json"));
    const rows = [
      { id: "nonceRow4471000000000000000001", title: "Operación 4471", description: "Qingdao Bluewave Textiles Co., Ltd. · arribo estimado 22/10" },
      { id: "nonceRow4476000000000000000002", title: "Operación 4476", description: "Qingdao Bluewave Textiles Co., Ltd. · arribo estimado 29/10" },
    ];
    expect(toMetaMessage({ kind: "list", to: PHONE, body: importerEsAR.operationChoice.body, buttonTitle: "Elegir operación", rows })).toEqual(expected("send-list.json"));
    const choice = { body: importerEsAR.operationChoice.body, list: { buttonTitle: "Elegir operación", rows: rows.map((row) => ({ nonce: row.id, title: row.title, description: row.description, operationId: `op-${row.title.slice(-4)}` })) } };
    expect(systemReplyMessage(choice, PHONE)).toEqual(expected("send-list.json"));
    expect(systemReplyMessage({ body: importerEsAR.rejectedMedia }, PHONE)).toMatchObject({ type: "text", text: { body: importerEsAR.rejectedMedia } });
    expect(() => toMetaMessage({ kind: "buttons", to: PHONE, body, buttons: [...buttons, { id: "nonceFourth00000000000000000004", title: "Cuarto" }] })).toThrow();
    expect(() => toMetaMessage({ kind: "buttons", to: PHONE, body, buttons: [{ id: "nonceLong0000000000000000000001", title: "Un título de más de veinte" }] })).toThrow();
    const eleven = Array.from({ length: 11 }, (_, index) => ({ id: `nonceRow${String(index).padStart(22, "0")}`, title: `Operación 44${String(index).padStart(2, "0")}` }));
    expect(() => toMetaMessage({ kind: "list", to: PHONE, body: "Elegí", buttonTitle: "Elegir operación", rows: eleven })).toThrow();
    expect(() => toMetaMessage({ kind: "list", to: PHONE, body: "Elegí", buttonTitle: "Elegir operación", rows: [{ id: "nonceRow0000000000000000000001", title: "Operación 4471 con un título largo" }] })).toThrow();
  });

  it("[FL-091] text without link previews; a template with the wrong arity or buttons is never built", () => {
    expect(toMetaMessage({ kind: "text", to: PHONE, body: "Recibimos el packing list." })).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "5491155500101", type: "text", text: { preview_url: false, body: "Recibimos el packing list." } });
    expect(() => toMetaMessage({ kind: "text", to: PHONE, body: "x".repeat(4_097) })).toThrow();
    expect(() => toMetaMessage({ ...DOCS_REQUEST, params: DOCS_REQUEST.kind === "template" ? DOCS_REQUEST.params.slice(1) : [] })).toThrow();
    expect(() => toMetaMessage({ ...DOCS_REQUEST, buttons: DOCS_REQUEST.kind === "template" ? DOCS_REQUEST.buttons.slice(1) : [] })).toThrow();
    expect(() => toMetaMessage({ kind: "template", to: PHONE, name: "legajo_aprobado", params: ["4471\n"], buttons: [] })).toThrow();
  });
});

describe("[FL-091] SendWhatsAppMessage in live mode", () => {
  it("[FL-091] sends the exact JSON with the connected number and the pinned API version", async () => {
    sdk.on(SendWhatsAppMessageCommand).resolves({ messageId: "wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABEYEjdBQkZFM0U4RjBGMzQ1RjY3RgA=" });
    const transport = await liveTransport({ approved: true });
    const result = await transport.send({ message: toMetaMessage(DOCS_REQUEST), record: { operationId: "op-4471", clockId: "GLOBAL#firm-delta", messageId: "msg-0a1b" } });
    expect(result).toMatchObject({ providerMessageId: "wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABEYEjdBQkZFM0U4RjBGMzQ1RjY3RgA=", simulated: false, status: "SENT" });
    const input = sdk.commandCalls(SendWhatsAppMessageCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ originationPhoneNumberId: PHONE_NUMBER_ID, metaApiVersion: META_API_VERSION });
    expect(sentJson()).toEqual(expected("send-template.json"));
  });

  it("[FL-091] a template Meta has not approved is refused before calling AWS", async () => {
    const transport = await liveTransport();
    await expect(transport.send({ message: toMetaMessage(DOCS_REQUEST) })).rejects.toMatchObject({ code: "INVALID" });
    expect(sdk.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
  });

  it("[FL-091] live WhatsApp only writes to the registered demo phones", async () => {
    const transport = await liveTransport({ allowed: [OTHER_PHONE] });
    await expect(transport.send({ message: toMetaMessage({ kind: "text", to: PHONE, body: "Hola" }) })).rejects.toMatchObject({ code: "RECIPIENT_NOT_ALLOWED" });
    expect(sdk.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
  });

  it("[FL-091] throttling is retried with backoff; a validation error or a timed-out send is not", async () => {
    const throttled = Object.assign(new Error("slow down"), { name: "ThrottledRequestException" });
    sdk.on(SendWhatsAppMessageCommand).rejectsOnce(throttled).rejectsOnce(throttled).resolves({ messageId: "wamid.HBgNRETRY" });
    const transport = await liveTransport();
    expect((await transport.send({ message: toMetaMessage({ kind: "text", to: PHONE, body: "Hola" }) })).providerMessageId).toBe("wamid.HBgNRETRY");
    expect(sdk.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(3);
    sdk.reset();
    sdk.on(SendWhatsAppMessageCommand).rejects(Object.assign(new Error("bad"), { name: "ValidationException" }));
    await expect(transport.send({ message: toMetaMessage({ kind: "text", to: PHONE, body: "Hola" }) })).rejects.toMatchObject({ code: "INVALID" });
    expect(sdk.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(1);
    // A send that timed out may have reached the importer: it is never repeated.
    sdk.reset();
    sdk.on(SendWhatsAppMessageCommand).rejects(Object.assign(new Error("late"), { name: "TimeoutError" }));
    await expect(transport.send({ message: toMetaMessage({ kind: "text", to: PHONE, body: "Hola" }) })).rejects.toMatchObject({ code: "TIMEOUT", retryable: false });
    expect(sdk.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(1);
  });

  it("[FL-091] there is no live transport without a connected number", async () => {
    const world = await waWorld();
    expect(() =>
      liveWhatsAppTransport({ phoneNumberId: "not-connected", mediaBucket: "b", allowedPhones: [], templates: world.stores.connector.reference, media: world.media, realClock: world.deps.realClock }),
    ).toThrow(/P-01/);
  });
});
