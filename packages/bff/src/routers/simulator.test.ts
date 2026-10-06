import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { QuotaExceededError } from "@legajo/shared/errors";
import { parseEnvelope } from "../channels/whatsapp/payloads";
import { hasValidSimSignature } from "../channels/whatsapp/sim-envelope";
import { CLOCK, FIRM, OPERATION, REAL_NOW, START_SIM } from "../services/operations-admin/testing";
import { type ConsoleServiceWorld, GUEST, GUEST_CLOCK, consoleServiceWorld, guestOperation } from "./console-testing";
import { LIVE_MODE_REASON } from "./simulator";
import { DIEGO, MARTINA, PABLO } from "./testing";

const PHONE = "+5491155500101";
const SIM_ENVELOPE_KEY = new TextEncoder().encode("legajo-console-tests-sim-envelope");

/** Our template to Norpampa with its four buttons, as the pipeline stores it. */
async function docsRequest(world: ConsoleServiceWorld): Promise<void> {
  await world.stores.connector.conversations.appendMessage({
    messageId: "msg-0a1b2c3d4e",
    operationId: OPERATION,
    firmId: FIRM,
    clockId: CLOCK,
    direction: "OUT",
    channel: "WHATSAPP",
    kind: "DOCS_REQUEST",
    counterpart: "IMPORTER",
    importerId: "imp-norpampa",
    to: PHONE,
    from: "simulated",
    body: "Hola Lucía, te escribimos desde Estudio Delta por la operación 4471.",
    template: { name: "legajo_docs_pendientes", params: ["Estudio Delta", "4471", "Austral Aurora", "22/10", "certificado de origen"] },
    buttons: [
      { action: "UPLOAD", title: "Subir documentos", url: "https://legajo.demo.craftech.io/u/Zq3v9Kf0mX2bR7wLpT4yNc8hJd1sGa6eUo5iQkVxWtY" },
      { action: "SUPPLIER_SENDS", title: "Los manda el proveedor", nonce: "nonceSupplierSends000000000000001" },
    ],
    status: "DELIVERED",
    providerMessageId: "wamid.SIM.OUT000001",
    author: "AGENT",
    simulated: true,
    sentAtSim: START_SIM,
    sentAtReal: REAL_NOW,
  });
}

function messageOf(world: ConsoleServiceWorld, index = -1) {
  const event = world.envelopes.at(index);
  const record = event?.Records[0];
  if (record === undefined) throw new Error("no envelope");
  const parsed = parseEnvelope(record.Sns.Message);
  return { record, message: parsed.changes[0]?.messages[0] };
}

describe("simulator router [FL-083]", () => {
  it("[FL-083] shows the importer's thread as the phone does: rendered text, buttons with their gloss and link, never a nonce", async () => {
    const world = await consoleServiceWorld();
    await docsRequest(world);
    const { threads } = await world.caller(MARTINA).simulator.threads({});
    expect(threads).toMatchObject([
      {
        importerId: "imp-norpampa",
        phoneMasked: "+54*******0101",
        operations: [{ operationId: OPERATION, operationNumber: "4471" }],
        unread: 1,
        typing: false,
        messages: [
          {
            messageId: "msg-0a1b2c3d4e",
            direction: "OUT",
            operationNumber: "4471",
            template: "legajo_docs_pendientes",
            glossEn: expect.any(String),
            buttons: [
              { action: "UPLOAD", glossEn: "Upload documents", url: expect.stringContaining("/u/") },
              { action: "SUPPLIER_SENDS", glossEn: "The supplier sends them" },
            ],
            status: "DELIVERED",
          },
        ],
      },
    ]);
    expect(JSON.stringify(threads)).not.toMatch(/nonce|wamid|5550 ?0101/);
    await world.stores.connector.world.markInFlight({ operationId: OPERATION, clockId: CLOCK, eventId: "evt-1" });
    expect((await world.caller(MARTINA).simulator.threads({})).threads[0]?.typing).toBe(true);
    expect((await world.caller(PABLO).simulator.threads({})).threads).toEqual([]);
  });

  it("[FL-083] a text of the importer goes to InboundWhatsApp as a signed envelope from the registered phone", async () => {
    const world = await consoleServiceWorld();
    const answer = await world.caller(MARTINA).simulator.sendText({ importerId: "imp-norpampa", text: "Los manda el proveedor" });
    expect(answer).toMatchObject({ importerId: "imp-norpampa", wamid: expect.stringMatching(/^wamid\.SIM\./) });
    const { record, message } = messageOf(world);
    expect(hasValidSimSignature(SIM_ENVELOPE_KEY, record)).toBe(true);
    expect(message).toMatchObject({ from: PHONE.slice(1), type: "text", text: { body: "Los manda el proveedor" } });
  });

  it("[FL-083] a tap sends the button's nonce in reply to our message; a link button sends nothing", async () => {
    const world = await consoleServiceWorld();
    await docsRequest(world);
    await world.caller(MARTINA).simulator.tapButton({ importerId: "imp-norpampa", messageId: "msg-0a1b2c3d4e", action: "SUPPLIER_SENDS" });
    expect(messageOf(world).message).toMatchObject({ type: "button", button: { payload: "nonceSupplierSends000000000000001" }, context: { id: "wamid.SIM.OUT000001" } });
    await expect(world.caller(MARTINA).simulator.tapButton({ importerId: "imp-norpampa", messageId: "msg-0a1b2c3d4e", action: "UPLOAD" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(world.caller(MARTINA).simulator.tapButton({ importerId: "imp-norpampa", messageId: "msg-0a1b2c3d4e", action: "OPT_OUT" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(world.envelopes).toHaveLength(1);
  });

  it("[FL-083] attaches a synthetic PDF of the operation's template, or one the user uploaded to Media/sim/", async () => {
    const world = await consoleServiceWorld();
    await world.caller(MARTINA).simulator.attachDocument({ importerId: "imp-norpampa", source: { kind: "SYNTHETIC", operationId: OPERATION, docType: "PACKING_LIST" } });
    expect(world.copies).toMatchObject([{ templateOperation: "op-4471", docType: "PACKING_LIST", version: 1, key: expect.stringMatching(/^sim\/[0-9A-Z]{26}\/0\.pdf$/) }]);
    expect(messageOf(world).message).toMatchObject({ type: "document", document: { id: `sim-media:${world.copies[0]?.key}`, mime_type: "application/pdf" } });

    const post = await world.caller(MARTINA).simulator.presignMedia({ importerId: "imp-norpampa", filename: "factura.pdf", sizeBytes: 120_000 });
    expect(post.key).toMatch(/^sim\/[0-9A-Z]{26}\/0\.pdf$/);
    await world.caller(MARTINA).simulator.attachDocument({ importerId: "imp-norpampa", source: { kind: "UPLOAD", key: post.key } });
    expect(messageOf(world).message).toMatchObject({ document: { id: `sim-media:${post.key}` } });
    await expect(world.caller(MARTINA).simulator.attachDocument({ importerId: "imp-norpampa", source: { kind: "UPLOAD", key: "guest/pub/firm-guest-41/e1/sim/X/0.pdf" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(world.caller(MARTINA).simulator.presignMedia({ importerId: "imp-norpampa", filename: "grande.pdf", sizeBytes: 10 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("[FL-083] «Marcar leído» marks every delivered message of the thread read", async () => {
    const world = await consoleServiceWorld();
    await docsRequest(world);
    expect(await world.caller(MARTINA).simulator.markRead({ importerId: "imp-norpampa" })).toEqual({ importerId: "imp-norpampa", marked: 1 });
    expect((await world.caller(MARTINA).simulator.threads({})).threads[0]).toMatchObject({ unread: 0, messages: [{ status: "READ" }] });
  });

  it("[FL-083] answers only in simulated mode outside guest worlds, and only for importers of the firm", async () => {
    const live = await consoleServiceWorld({ whatsappMode: "live" });
    await expect(live.caller(DIEGO).simulator.threads({})).rejects.toMatchObject({ code: "CONFLICT", cause: { reason: LIVE_MODE_REASON } });
    await expect(live.caller(DIEGO).simulator.sendText({ importerId: "imp-norpampa", text: "Hola" })).rejects.toMatchObject({ cause: { reason: LIVE_MODE_REASON } });
    const world = await consoleServiceWorld();
    await expect(world.caller(PABLO).simulator.sendText({ importerId: "imp-norpampa", text: "Hola" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(world.envelopes).toEqual([]);
  });

  it("[FL-083] a guest world keeps the simulator while WhatsApp runs live: its sends never leave the simulator", async () => {
    const world = await consoleServiceWorld({ guestWorld: true, whatsappMode: "live" });
    const { importerId } = await guestOperation(world);
    expect((await world.caller(GUEST).simulator.threads({})).threads.length).toBeGreaterThan(0);
    await world.caller(GUEST).simulator.sendText({ importerId, text: "Hola" });
    expect(world.envelopes).toHaveLength(1);
  });

  it("[FL-111] a guest world's SIMULATOR_MESSAGES and PDF_UPLOADS refuse the phone with QUOTA_EXCEEDED; its keys live under the world's prefix", async () => {
    const world = await consoleServiceWorld({ guestWorld: true });
    const { importerId, operationId } = await guestOperation(world);
    const post = await world.caller(GUEST).simulator.presignMedia({ importerId, filename: "factura.pdf", sizeBytes: 1_000 });
    expect(post.key).toMatch(/^guest\/res\/firm-guest-01\/e1\/sim\//);
    await world.exhaust(GUEST_CLOCK, "PDF_UPLOADS");
    const upload = await world.caller(GUEST).simulator.attachDocument({ importerId, source: { kind: "SYNTHETIC", operationId, docType: "PACKING_LIST" } }).catch((error: unknown) => error);
    expect(upload instanceof TRPCError && upload.cause instanceof QuotaExceededError && upload.cause.kind).toBe("PDF_UPLOADS");
    await world.exhaust(GUEST_CLOCK, "SIMULATOR_MESSAGES");
    const text = await world.caller(GUEST).simulator.sendText({ importerId, text: "Hola" }).catch((error: unknown) => error);
    expect(text).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(text instanceof TRPCError && text.cause instanceof QuotaExceededError && text.cause.kind).toBe("SIMULATOR_MESSAGES");
    expect(world.envelopes).toEqual([]);
  });
});
