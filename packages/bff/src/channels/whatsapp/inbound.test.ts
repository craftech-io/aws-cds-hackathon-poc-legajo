import { describe, expect, it, vi } from "vitest";
import { importerEsAR } from "../../copy/es-AR";
import { turnEventId } from "../adapter";
import { type InboundSummary, processWhatsAppEvent } from "./inbound";
import type { MessageResult } from "./inbound-message";
import { derivedMessageId } from "./records";
import { CLOCK, META_PHONE_NUMBER_ID, PHONE, REAL_NOW, RESERVE_PHONE, type WaWorld, liveEvent, sentWithButtons, simEvent, waWorld } from "./testing";

const LIVE_WAMID = "wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABIYFDNBQjI4RjdEMkUzOTVDNjE2RDQ2AA==";

function only(summary: InboundSummary): MessageResult {
  const [record] = summary.records;
  expect(record?.accepted).toBe(true);
  const [message] = record?.messages ?? [];
  if (message === undefined) throw new Error("no message in the summary");
  return message;
}

async function inbound(world: WaWorld) {
  return world.stores.connector.conversations.listMessages("op-4471", { direction: "IN" });
}

describe("[FL-090] live events of End User Messaging Social", () => {
  it("[FL-090] a live text from the topic is the importer's message and a turn of its only operation", async () => {
    const world = await waWorld();
    const result = only(await processWhatsAppEvent(liveEvent("sns-text.json", { TEXT: "¿Ya llegó lo del proveedor?" }), world.deps));
    expect(result).toMatchObject({ outcome: "TURN", operationId: "op-4471" });
    const [message] = await inbound(world);
    expect(message).toMatchObject({
      channel: "WHATSAPP",
      counterpart: "IMPORTER",
      importerId: "imp-norpampa",
      from: PHONE,
      to: META_PHONE_NUMBER_ID,
      body: "¿Ya llegó lo del proveedor?",
      providerMessageId: LIVE_WAMID,
      status: "RECEIVED",
      trusted: true,
      simulated: false,
      sentAtSim: "2026-10-14T13:30:00.000Z",
      sentAtReal: "2026-10-15T13:05:00.000Z",
    });
    expect(JSON.stringify(message)).not.toContain("Contacto");
    expect(world.events).toEqual([
      { type: "AGENT_TURN", eventId: turnEventId("IMPORTER_MESSAGE", LIVE_WAMID), trigger: "IMPORTER_MESSAGE", operationId: "op-4471", clockId: CLOCK, firmId: "firm-delta", messageId: message?.messageId, eventAtSim: "2026-10-14T13:30:00.000Z", intakeEventIds: [] },
    ]);
  });

  it("[FL-090] the simulated envelope leaves the same records, marked simulated", async () => {
    const live = await waWorld();
    const simulated = await waWorld();
    await processWhatsAppEvent(liveEvent("sns-text.json", { TEXT: "Hola, ¿qué falta?" }), live.deps);
    await processWhatsAppEvent(simEvent({ type: "text", text: "Hola, ¿qué falta?" }), simulated.deps);
    const strip = (rows: Awaited<ReturnType<typeof inbound>>) => rows.map(({ messageId: _id, providerMessageId: _wamid, simulated: _simulated, to: _to, sentAtReal: _real, createdAt: _c, updatedAt: _u, ...rest }) => rest);
    expect(strip(await inbound(simulated))).toEqual(strip(await inbound(live)));
    expect((await inbound(simulated))[0]).toMatchObject({ simulated: true, to: "simulated" });
    expect(simulated.events.map((event) => event.type)).toEqual(live.events.map((event) => event.type));
  });

  it("[FL-090] a template quick reply, a reply button and a list row all resolve their nonce", async () => {
    for (const [fixture, template] of [["sns-template-reply.json", true], ["sns-button-reply.json", false], ["sns-list-reply.json", false]] as const) {
      const world = await waWorld();
      const sent = await sentWithButtons(world, [{ action: "TALK_TO_FIRM" }], { template, wamid: "wamid.HBgNOUR-1" });
      const result = only(await processWhatsAppEvent(liveEvent(fixture, { NONCE: sent.nonces[0] ?? "", TITLE: "Hablar con el estudio", CONTEXT: sent.wamid }), world.deps));
      expect(result.outcome).toBe("TURN");
      expect(world.events).toMatchObject([{ type: "AGENT_TURN", operationId: "op-4471", messageId: result.messageId }]);
      expect((await inbound(world))[0]).toMatchObject({ body: "Hablar con el estudio", inReplyTo: sent.wamid, interactive: { buttonAction: "TALK_TO_FIRM", buttonResolved: true } });
    }
  });

  it("[FL-090] statuses of the same envelope update our message before its messages are read", async () => {
    const world = await waWorld();
    const sent = await sentWithButtons(world, [{ action: "QUESTION" }], { wamid: "wamid.HBgNSENT-1" });
    await world.stores.connector.conversations.updateMessage({ operationId: "op-4471", messageId: sent.messageId, sentAtSim: "2026-10-14T13:30:00.000Z" }, { status: "SENT" });
    const summary = await processWhatsAppEvent(liveEvent("sns-statuses.json", { SENT_ID: sent.wamid, MARKETING_ID: "wamid.HBgNNONE-2", FAILED_ID: "wamid.HBgNNONE-3" }), world.deps);
    expect(summary.records[0]?.statuses.map((status) => status.outcome)).toEqual(["UNCHANGED", "APPLIED", "APPLIED", "UNKNOWN_MESSAGE", "UNKNOWN_MESSAGE"]);
    expect((await world.stores.connector.conversations.getMessage("op-4471", sent.messageId))?.status).toBe("READ");
  });
});

describe("[FL-011] “Los manda el proveedor” and the contact confirmation", () => {
  it("[FL-011] the SUPPLIER_SENDS button resolves its nonce: Message IN with the button, a turn of that operation", async () => {
    const world = await waWorld();
    const sent = await sentWithButtons(world, [{ action: "UPLOAD" }, { action: "SUPPLIER_SENDS" }, { action: "QUESTION" }, { action: "OPT_OUT" }], { template: true, kind: "DOCS_REQUEST" });
    const result = only(await processWhatsAppEvent(simEvent({ type: "template_reply", nonce: sent.nonces[1] ?? "", title: "Los manda el proveedor" }, { contextWamid: sent.wamid }), world.deps));
    expect(result).toMatchObject({ outcome: "TURN", operationId: "op-4471" });
    expect((await inbound(world))[0]).toMatchObject({ body: "Los manda el proveedor", interactive: { buttonAction: "SUPPLIER_SENDS", buttonResolved: true } });
    expect(world.events).toMatchObject([{ type: "AGENT_TURN", trigger: "IMPORTER_MESSAGE", eventId: turnEventId("IMPORTER_MESSAGE", "wamid.SIM.01JAB3C4D5E6F7G8H9J0KMNPQR"), messageId: result.messageId }]);
    expect(world.replies).toEqual([]);
  });

  it("[FL-011] “Sí, escribile” confirms the contact of its nonce through confirm_supplier_contact, once", async () => {
    const world = await waWorld();
    const payload = { supplierId: "sup-qingdao", contactId: "ctc-qingdao-1" };
    const sent = await sentWithButtons(world, [{ action: "CONFIRM_CONTACT", payload }, { action: "REJECT_CONTACT", payload }, { action: "OTHER_CONTACT" }]);
    const tap = (wamid: string) => simEvent({ type: "button_reply", nonce: sent.nonces[0] ?? "", title: "Sí, escribile" }, { contextWamid: sent.wamid, wamid });
    expect(only(await processWhatsAppEvent(tap("wamid.SIM.TAP1"), world.deps)).outcome).toBe("CONTACT_DECISION");
    expect(world.contacts).toMatchObject([{ operationId: "op-4471", supplierId: "sup-qingdao", contactId: "ctc-qingdao-1", decision: "CONFIRM", wamid: "wamid.SIM.TAP1" }]);
    expect(world.events).toEqual([]);
    // A second tap of the same one-shot button is refused and read as text.
    expect(only(await processWhatsAppEvent(tap("wamid.SIM.TAP2"), world.deps)).outcome).toBe("TURN");
    expect(world.contacts).toHaveLength(1);
    const refused = await world.stores.connector.audit.listByOperation("op-4471");
    expect(refused.map((decision) => [decision.decision, decision.action])).toContainEqual(["DENY", "NONCE_USED"]);
  });

  it("the QUESTION button gets the fixed follow-up question, without a turn", async () => {
    const world = await waWorld();
    const sent = await sentWithButtons(world, [{ action: "QUESTION" }]);
    const result = only(await processWhatsAppEvent(simEvent({ type: "button_reply", nonce: sent.nonces[0] ?? "", title: "Tengo una duda" }), world.deps));
    expect(result.outcome).toBe("QUESTION_PROMPT");
    expect(world.replies).toMatchObject([{ kind: "REPLY", textKey: "questionPrompt", body: importerEsAR.questionPrompt, operationId: "op-4471", inReplyTo: { messageId: result.messageId } }]);
    expect(world.events).toEqual([]);
  });
});

describe("[FL-016] opting out by button or exact keyword", () => {
  it("[FL-016] the OPT_OUT button revokes the consent without a turn", async () => {
    const world = await waWorld();
    const sent = await sentWithButtons(world, [{ action: "OPT_OUT" }], { template: true, kind: "DOCS_REQUEST" });
    const result = only(await processWhatsAppEvent(simEvent({ type: "template_reply", nonce: sent.nonces[0] ?? "", title: "No recibir avisos" }), world.deps));
    expect(result.outcome).toBe("OPTED_OUT");
    expect(world.revoked).toMatchObject([{ importerId: "imp-norpampa", firmId: "firm-delta", operationIds: ["op-4471"], via: "BUTTON", messageId: result.messageId }]);
    expect(world.events).toEqual([]);
    expect((await inbound(world))[0]).toMatchObject({ interactive: { buttonAction: "OPT_OUT" } });
  });

  it("[FL-016] BAJA, STOP and “no quiero recibir más” opt out; a longer sentence goes to the agent", async () => {
    for (const text of ["BAJA", "stop", "  No quiero recibir más!  "]) {
      const world = await waWorld();
      expect(only(await processWhatsAppEvent(simEvent({ type: "text", text }), world.deps)).outcome).toBe("OPTED_OUT");
      expect(world.revoked).toMatchObject([{ via: "KEYWORD", operationIds: ["op-4471"] }]);
      expect(world.events).toEqual([]);
    }
    const world = await waWorld();
    expect(only(await processWhatsAppEvent(simEvent({ type: "text", text: "no quiero recibir más avisos del proveedor, solo del estudio" }), world.deps)).outcome).toBe("TURN");
    expect(world.revoked).toEqual([]);
  });
});

describe("[FL-018] images, audio, video and stickers get the fixed reply", () => {
  it("[FL-018] an image with a caption: fixed reply, no intake, the caption goes to the turn", async () => {
    const world = await waWorld();
    const result = only(await processWhatsAppEvent(liveEvent("sns-image.json", { TEXT: "Esta es la factura" }), world.deps));
    expect(result.outcome).toBe("MEDIA_REJECTED");
    expect((await inbound(world))[0]).toMatchObject({ body: "Esta es la factura", attachments: [{ status: "REJECTED", contentType: "image/jpeg" }] });
    expect(world.replies).toMatchObject([{ textKey: "rejectedMedia", body: importerEsAR.rejectedMedia }]);
    expect(world.events).toMatchObject([{ type: "AGENT_TURN", trigger: "IMPORTER_MESSAGE" }]);
    expect(world.media.objects.size).toBe(0);
  });

  it("[FL-018] audio, video, a sticker or a reaction: fixed reply, no intake and no turn", async () => {
    for (const mediaType of ["audio", "video", "sticker"] as const) {
      const world = await waWorld();
      expect(only(await processWhatsAppEvent(simEvent({ type: "media", mediaType }), world.deps)).outcome).toBe("MEDIA_REJECTED");
      expect(world.replies.map((reply) => reply.textKey)).toEqual(["rejectedMedia"]);
      expect(world.events).toEqual([]);
    }
    const world = await waWorld();
    expect(only(await processWhatsAppEvent(liveEvent("sns-reaction.json", { CONTEXT: "wamid.HBgNOUR-9" }), world.deps)).outcome).toBe("MEDIA_REJECTED");
    expect(world.events.filter((event) => event.type === "INTAKE_DOCUMENT")).toEqual([]);
  });
});

describe("[FL-034] duplicates", () => {
  it("[FL-034] the same wamid twice is one Message IN and one turn", async () => {
    const world = await waWorld();
    const event = liveEvent("sns-text.json", { TEXT: "¿Cómo sigue lo de los documentos?" });
    only(await processWhatsAppEvent(event, world.deps));
    expect(only(await processWhatsAppEvent(event, world.deps)).outcome).toBe("DUPLICATE");
    expect(await inbound(world)).toHaveLength(1);
    expect(world.events).toHaveLength(1);
  });

  it("[FL-034] a text whose turn could not be enqueued is not a duplicate: the redelivery writes it once and enqueues the turn", async () => {
    const world = await waWorld();
    let failures = 1;
    const events = { enqueue: async (event: WaWorld["events"][number]) => (failures-- > 0 ? Promise.reject(new Error("SQS unavailable")) : void world.events.push(event)) };
    const deps = { ...world.deps, events };
    const event = liveEvent("sns-text.json", { TEXT: "¿Cómo sigue lo de los documentos?" });
    await expect(processWhatsAppEvent(event, deps)).rejects.toThrow("SQS unavailable");
    expect(only(await processWhatsAppEvent(event, deps))).toMatchObject({ outcome: "TURN", operationId: "op-4471" });
    expect(await inbound(world)).toHaveLength(1);
    expect(world.events.map((queued) => queued.eventId)).toEqual([turnEventId("IMPORTER_MESSAGE", LIVE_WAMID)]);
    expect(only(await processWhatsAppEvent(event, deps)).outcome).toBe("DUPLICATE");
  });

  it("[FL-034] a PDF whose download failed is not a duplicate: the redelivery accepts it into the timeline", async () => {
    const world = await waWorld();
    const key = "sim/msg-01JAB3C4D5E6F7G8H9J0KMNPQR/1.pdf";
    world.media.objects.set(key, { sizeBytes: 480_000, contentType: "application/pdf" });
    vi.spyOn(world.deps.transport, "fetchMedia").mockRejectedValueOnce(new Error("media download timed out"));
    const event = simEvent({ type: "document", mediaRef: `sim-media:${key}`, filename: "packing-list.pdf" });
    await expect(processWhatsAppEvent(event, world.deps)).rejects.toThrow("media download timed out");
    expect(await inbound(world)).toEqual([]);
    expect(only(await processWhatsAppEvent(event, world.deps))).toMatchObject({ outcome: "DOCUMENT", operationId: "op-4471" });
    expect((await inbound(world))[0]?.attachments).toMatchObject([{ status: "ACCEPTED", s3Key: key }]);
    expect((await world.stores.connector.world.listPending(CLOCK)).scans).toMatchObject([{ objectKey: key, operationId: "op-4471" }]);
  });
});

describe("[FL-093] a number without an importer", () => {
  it("[FL-093] gets the fixed reply once a day, no record, no turn; audited in the world that leased it", async () => {
    const world = await waWorld();
    await world.stores.connector.world.acquireLease({ kind: "PHONE", value: RESERVE_PHONE, holder: CLOCK, atReal: REAL_NOW });
    const send = vi.spyOn(world.deps.transport, "send");
    const from = { FROM: RESERVE_PHONE.slice(1) };
    expect(only(await processWhatsAppEvent(liveEvent("sns-text.json", { ...from, TEXT: "Hola, ¿me pasan el estado?" }), world.deps)).outcome).toBe("UNKNOWN_SENDER");
    await processWhatsAppEvent(liveEvent("sns-text.json", { ...from, TEXT: "¿Hola?", WAMID: "wamid.HBgNSECOND" }), world.deps);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].message).toMatchObject({ type: "text", to: RESERVE_PHONE.slice(1), text: { body: importerEsAR.unknownSender } });
    expect(await inbound(world)).toEqual([]);
    expect(world.events).toEqual([]);
    const denied = await world.stores.connector.audit.listByDecision("firm-delta", "DENY");
    expect(denied.map((decision) => decision.action)).toEqual(["UNKNOWN_SENDER", "UNKNOWN_SENDER"]);
    expect(JSON.stringify(denied)).not.toContain(RESERVE_PHONE.slice(1));
  });

  it("two importers with one phone hash are an audited error, never an identity", async () => {
    const world = await waWorld();
    const parties = { ...world.stores.connector.parties, findImporterByPhoneHash: async () => ({ status: "AMBIGUOUS" as const, ids: ["imp-norpampa"] }) };
    const deps = { ...world.deps, data: { ...world.stores.connector, parties } };
    expect(only(await processWhatsAppEvent(simEvent({ type: "text", text: "Hola" }), deps)).outcome).toBe("AMBIGUOUS_SENDER");
    expect((await world.stores.connector.audit.listByDecision("firm-delta", "DENY")).map((decision) => decision.action)).toEqual(["IDENTITY_AMBIGUOUS"]);
    expect(world.events).toEqual([]);
  });
});

describe("rate limit of the world (the counter is channels/rate-limit.ts)", () => {
  it("the first message over the limit gets one DENY and one fixed reply; the rest of the hour is dropped", async () => {
    const world = await waWorld({ rateLimitPerHour: 2 });
    const outcomes: string[] = [];
    for (const [index, text] of ["uno", "dos", "tres", "cuatro"].entries()) {
      outcomes.push(only(await processWhatsAppEvent(simEvent({ type: "text", text }, { wamid: `wamid.SIM.RATE${index}` }), world.deps)).outcome);
    }
    expect(outcomes).toEqual(["TURN", "TURN", "RATE_LIMITED", "RATE_LIMITED"]);
    expect((await world.stores.connector.audit.listByOperation("op-4471")).map((decision) => decision.action)).toEqual(["RATE_LIMIT"]);
    expect(world.replies).toMatchObject([{ textKey: "rateLimited", messageId: derivedMessageId("wamid.SIM.RATE2", "rateLimited") }]);
    expect((await inbound(world)).map((message) => message.status)).toEqual(["RECEIVED", "RECEIVED", "DISCARDED"]);
    expect(world.events).toHaveLength(2);
  });
});
