// The outbound pipeline end to end over the in-memory connector (docs/tool-catalog.md, target
// `messaging`): control → policy → G2 → deterministic verification → render → fence → transport →
// `Conversations` + `AuditLog`, deferrals with their `TIMER#DEFERRED_SEND#` and the firing that sends
// them, and the refusals each step answers.
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { beforeEach, describe, expect, it } from "vitest";
import { resendDeferred } from "./defer";
import { orderedMessageId, sendOrdered } from "./ordered";
import { sendOutbound } from "./pipeline";
import { FRI_10_QINGDAO, IMPORTER_PHONE, QINGDAO, THU_10_AR, outboundWorld, type OutboundWorld } from "./testing";
import type { OutboundRequest } from "./types";

let world: OutboundWorld;

beforeEach(async () => {
  world = await outboundWorld();
});

const DOSSIER = {
  operationNumber: "4471",
  firmName: "Estudio Delta",
  vessel: "Austral Aurora",
  etaText: "22/10",
  invoiceNumber: "QBT-2026-0917",
  missingDocuments: "certificado de origen y packing list",
  deadlines: { supplier: { text: "October 19, 10:00 (Asia/Shanghai)" } },
};

async function audit(): Promise<Awaited<ReturnType<OutboundWorld["stores"]["connector"]["audit"]["listByOperation"]>>> {
  return world.stores.connector.audit.listByOperation("op-4471");
}

function docsTemplate(turnId: string): OutboundRequest {
  return {
    operationId: "op-4471",
    channel: "WHATSAPP",
    kind: "DOCS_REQUEST",
    author: "AGENT",
    textSource: "MODEL",
    trigger: "MILESTONE",
    turnId,
    eventAtSim: THU_10_AR,
    template: { name: "legajo_docs_pendientes", params: ["Estudio Delta", "4471", "Austral Aurora", "22/10", "certificado de origen y packing list"] },
    refs: { docTypes: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] },
  };
}

function supplierEmail(turnId: string, eventAtSim: string, text: string): OutboundRequest {
  return { operationId: "op-4471", channel: "EMAIL", counterpart: "SUPPLIER", kind: "DOCS_REQUEST", author: "AGENT", textSource: "MODEL", trigger: "CONTACT_CONFIRMED", turnId, eventAtSim, text, refs: { docTypes: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] } };
}

const EMAIL_TEXT = "Hello, for invoice QBT-2026-0917 we still need the packing list and the certificate of origin. Please send them by October 19, 10:00 (Asia/Shanghai). Thank you.";

describe("[FL-007] a template to the importer", () => {
  it("goes out with its nonces and upload link, and leaves the message and its ALLOW", async () => {
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }]);
    const result = await sendOutbound(world.deps, docsTemplate(turnId), world.call());
    expect(result).toMatchObject({ status: "SENT", templateUsed: "legajo_docs_pendientes" });
    if (result.status !== "SENT") throw new Error("expected SENT");
    const message = await world.stores.connector.conversations.getMessage("op-4471", result.messageId);
    expect(message).toMatchObject({ direction: "OUT", status: "DELIVERED", to: IMPORTER_PHONE, from: "simulated", simulated: true, template: { name: "legajo_docs_pendientes" }, turnId });
    expect(message?.buttons.map((button) => button.action)).toEqual(["UPLOAD", "SUPPLIER_SENDS", "QUESTION", "OPT_OUT"]);
    expect(message?.buttons.find((button) => button.action === "UPLOAD")?.url).toMatch(/^https:\/\/legajo\.demo\.craftech\.io\/u\/T0+1$/);
    expect(message?.buttons.filter((button) => button.nonce !== undefined)).toHaveLength(3);
    expect(world.uploads).toEqual([{ operationId: "op-4471", docTypes: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] }]);
    const allow = await world.stores.connector.audit.findAllowForMessage("op-4471", result.messageId);
    expect(allow).toMatchObject({ decision: "ALLOW", action: "SEND_WHATSAPP", actor: "AGENT", trigger: "MILESTONE" });
    expect(allow?.evaluated.map((rule) => rule.ruleId)).toContain("CP-WORLD-QUOTA");
    expect(allow?.ruleIds).toEqual(expect.arrayContaining(["CP-OPTIN", "CP-HOURS-AR", "CP-RECIPIENT-FENCE"]));
  });
});

describe("[FL-054] a figure or a date that no tool returned", () => {
  it("is refused as GROUNDING_FAIL, audited, and nothing is written or sent", async () => {
    const window = await world.inbound("¿Cuándo llega el buque?", "2026-10-15T09:30:00-03:00");
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "IMPORTER_MESSAGE");
    const result = await sendOutbound(world.deps, { operationId: "op-4471", channel: "WHATSAPP", kind: "REPLY", author: "AGENT", textSource: "MODEL", trigger: "IMPORTER_MESSAGE", turnId, answers: window, eventAtSim: THU_10_AR, text: "El buque Austral Aurora llega el 25/10." }, world.call());
    expect(result).toMatchObject({ status: "REFUSED", failure: { ok: false, error: { code: "GROUNDING_FAIL", reason: "GROUNDING_FAIL" } } });
    expect(JSON.stringify(result)).toContain("date 25/10");
    const rows = await audit();
    expect(rows).toEqual([expect.objectContaining({ decision: "DENY", action: "SEND_WHATSAPP", reason: expect.stringContaining("GROUNDING_FAIL") })]);
    expect((await world.stores.connector.conversations.listMessages("op-4471", { direction: "OUT" })).length).toBe(0);
  });

  it("G2's refusal is GROUNDING_FAIL under rule G2, and G2 down fails closed", async () => {
    await world.inbound("¿Cuándo llega el buque?", "2026-10-15T09:30:00-03:00");
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "IMPORTER_MESSAGE");
    const reply: OutboundRequest = { operationId: "op-4471", channel: "WHATSAPP", kind: "REPLY", author: "AGENT", textSource: "MODEL", trigger: "IMPORTER_MESSAGE", turnId, eventAtSim: THU_10_AR, text: "El arribo estimado es el 22/10." };
    world.g2.verdict = { action: "BLOCKED", groundingScore: 0.2, failure: "GROUNDING" };
    expect(await sendOutbound(world.deps, reply, world.call())).toMatchObject({ status: "REFUSED", ruleIds: ["G2"], failure: { error: { code: "GROUNDING_FAIL" } } });
    world.g2.verdict = "UNAVAILABLE";
    expect(await sendOutbound(world.deps, reply, world.call())).toMatchObject({ status: "REFUSED", failure: { error: { code: "UNAVAILABLE", reason: "GUARDRAIL_UNAVAILABLE" } } });
    expect(world.g2.calls[0]).toMatchObject({ kind: "REPLY", query: "¿Cuándo llega el buque?" });
  });
});

describe("the contact policy decides before anything is rendered", () => {
  it("free text outside the 24-hour window is TEMPLATE_REQUIRED", async () => {
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "MILESTONE");
    const result = await sendOutbound(world.deps, { operationId: "op-4471", channel: "WHATSAPP", kind: "DOCS_REQUEST", author: "AGENT", textSource: "MODEL", trigger: "MILESTONE", turnId, eventAtSim: THU_10_AR, text: "Faltan el certificado de origen y el packing list de la operación 4471." }, world.call());
    expect(result).toMatchObject({ status: "REFUSED", ruleIds: ["CP-WA-24H"], failure: { error: { code: "TEMPLATE_REQUIRED" } } });
    expect(world.g2.calls).toEqual([]);
  });

  it("a revoked consent stops even a template, with the rule audited", async () => {
    await world.stores.connector.parties.revokeConsent({ importerId: "imp-norpampa", atSim: "2026-10-14T11:00:00-03:00", by: "IMPORTER" });
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }]);
    const result = await sendOutbound(world.deps, docsTemplate(turnId), world.call());
    expect(result).toMatchObject({ status: "REFUSED", failure: { error: { code: "POLICY_DENIED" } } });
    expect((await audit()).at(-1)).toMatchObject({ decision: "DENY", ruleIds: [expect.stringMatching(/^CP-OPT/)] });
    expect(world.uploads).toEqual([]);
  });

  it("a link the turn did not create never reaches anyone (CP-NO-FOREIGN-LINKS)", async () => {
    await world.inbound("¿Dónde los subo?", "2026-10-15T09:30:00-03:00");
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "IMPORTER_MESSAGE");
    const result = await sendOutbound(world.deps, { operationId: "op-4471", channel: "WHATSAPP", kind: "REPLY", author: "AGENT", textSource: "MODEL", trigger: "IMPORTER_MESSAGE", turnId, eventAtSim: THU_10_AR, text: "Subilos en https://subidas-rapidas.net/4471 cuando puedas." }, world.call());
    expect(result).toMatchObject({ status: "REFUSED", ruleIds: ["CP-NO-FOREIGN-LINKS"] });
  });
});

describe("[FL-012] the first request to the supplier", () => {
  it("goes out by SES from the thread address, with its contact recorded", async () => {
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "CONTACT_CONFIRMED");
    const result = await sendOutbound(world.deps, supplierEmail(turnId, FRI_10_QINGDAO, EMAIL_TEXT), world.call());
    expect(result).toMatchObject({ status: "SENT", providerMessageId: "0100019a-ses-000001" });
    const input = world.ses.commandCalls(SendEmailCommand)[0]?.args[0].input;
    expect(input?.Destination?.ToAddresses).toEqual([QINGDAO]);
    expect(input?.FromEmailAddress).toContain(world.op4471.threadAddress);
    expect(input?.Content?.Simple?.Subject?.Data).toContain("[Op 4471]");
    if (result.status !== "SENT") throw new Error("expected SENT");
    expect(await world.stores.connector.conversations.getMessage("op-4471", result.messageId)).toMatchObject({ status: "SENT", counterpart: "SUPPLIER", contactId: "ctc-qingdao-1", to: QINGDAO, from: world.op4471.threadAddress });
  });

  it("an email without the invoice number is GROUNDING_FAIL (REQUIRED)", async () => {
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "CONTACT_CONFIRMED");
    const result = await sendOutbound(world.deps, supplierEmail(turnId, FRI_10_QINGDAO, "Hello, please send the packing list and the certificate of origin by October 19, 10:00 (Asia/Shanghai)."), world.call());
    expect(result).toMatchObject({ status: "REFUSED", failure: { error: { code: "GROUNDING_FAIL" } } });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});

describe("[FL-033] an email outside the supplier's hours", () => {
  it("is deferred with its timer, then sent in place when the timer fires", async () => {
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "CONTACT_CONFIRMED");
    const result = await sendOutbound(world.deps, supplierEmail(turnId, THU_10_AR, EMAIL_TEXT), world.call());
    expect(result).toMatchObject({ status: "DEFERRED", nextAllowedAt: "2026-10-16T09:00:00+08:00", zone: "Asia/Shanghai", decision: { ruleIds: ["CP-HOURS-SUPPLIER"] } });
    if (result.status !== "DEFERRED") throw new Error("expected DEFERRED");
    expect(result.timerKey).toBe(`TIMER#DEFERRED_SEND#${result.messageId}`);
    expect(world.armed).toEqual([expect.objectContaining({ timerId: result.messageId, dueAtSim: "2026-10-16T09:00:00+08:00", reason: "CP-HOURS-SUPPLIER" })]);
    expect(await world.stores.connector.conversations.getMessage("op-4471", result.messageId)).toMatchObject({ status: "DEFERRED", sentAtSim: "2026-10-16T01:00:00.000Z", deferredTimerKey: result.timerKey });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect((await audit()).at(-1)).toMatchObject({ decision: "DEFER", messageId: result.messageId });

    const fired = await resendDeferred(world.deps, { ...world.call(), actor: "SYSTEM" }, { operationId: "op-4471", messageId: result.messageId, timerKey: result.timerKey, atSim: "2026-10-16T09:00:00+08:00" });
    expect(fired).toEqual({ status: "SENT", messageId: result.messageId });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect(await world.stores.connector.conversations.getMessage("op-4471", result.messageId)).toMatchObject({ status: "SENT", policy: { decision: "ALLOW" } });
    expect(await world.stores.connector.audit.findAllowForMessage("op-4471", result.messageId)).toMatchObject({ decision: "ALLOW", actor: "SYSTEM" });
    expect(await resendDeferred(world.deps, world.call(), { operationId: "op-4471", messageId: result.messageId, timerKey: result.timerKey, atSim: "2026-10-16T09:00:00+08:00" })).toEqual({ status: "SENT", messageId: result.messageId });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it("a deferred send whose authorization was revoked meanwhile ends DISCARDED with the DENY", async () => {
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "CONTACT_CONFIRMED");
    const result = await sendOutbound(world.deps, supplierEmail(turnId, THU_10_AR, EMAIL_TEXT), world.call());
    if (result.status !== "DEFERRED") throw new Error("expected DEFERRED");
    await world.stores.connector.parties.setAuthorization({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: false, atSim: "2026-10-15T23:00:00-03:00", by: "BROKER:brk-ana" });
    const fired = await resendDeferred(world.deps, world.call(), { operationId: "op-4471", messageId: result.messageId, timerKey: result.timerKey, atSim: "2026-10-16T09:00:00+08:00" });
    expect(fired).toEqual({ status: "DENIED" });
    expect(await world.stores.connector.conversations.getMessage("op-4471", result.messageId)).toMatchObject({ status: "DISCARDED", policy: { decision: "DENY", ruleIds: ["CP-SUPPLIER-AUTH"] } });
    expect((await audit()).at(-1)).toMatchObject({ decision: "DENY", action: "DEFERRED_SEND" });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});

describe("a redelivered request", () => {
  it("is answered from its message and never sends twice", async () => {
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "CONTACT_CONFIRMED");
    const request = { ...supplierEmail(turnId, FRI_10_QINGDAO, EMAIL_TEXT), messageId: "msg-redelivered01" };
    expect(await sendOutbound(world.deps, request, world.call())).toMatchObject({ status: "SENT", messageId: "msg-redelivered01" });
    expect(await sendOutbound(world.deps, request, world.call())).toMatchObject({ status: "SENT", messageId: "msg-redelivered01", replayed: true });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(1);
  });
});

describe("a deferred template", () => {
  it("keeps its upload link and its nonces for when it fires, and a new daily cap defers it again", async () => {
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }]);
    const saturday = { ...docsTemplate(turnId), eventAtSim: "2026-10-17T10:00:00-03:00" };
    const result = await sendOutbound(world.deps, saturday, world.call());
    expect(result).toMatchObject({ status: "DEFERRED", nextAllowedAt: "2026-10-19T09:00:00-03:00", decision: { ruleIds: ["CP-HOURS-AR"] } });
    if (result.status !== "DEFERRED") throw new Error("expected DEFERRED");
    expect(world.uploads).toHaveLength(1);
    const deferred = await world.stores.connector.conversations.getMessage("op-4471", result.messageId);

    // Another documents request reached the importer that Monday first: the daily cap moves this one.
    await world.stores.connector.conversations.appendMessage({ messageId: "msg-earlier0001", operationId: "op-4471", firmId: "firm-delta", clockId: "GLOBAL#firm-delta", direction: "OUT", channel: "WHATSAPP", kind: "DOCS_REQUEST", counterpart: "IMPORTER", importerId: "imp-norpampa", to: IMPORTER_PHONE, from: "simulated", body: "x", status: "DELIVERED", author: "AGENT", sentAtSim: "2026-10-19T08:59:00-03:00", sentAtReal: "2026-09-26T14:00:00.000Z" });
    const again = await resendDeferred(world.deps, world.call(), { operationId: "op-4471", messageId: result.messageId, timerKey: result.timerKey, atSim: "2026-10-19T09:00:00-03:00" });
    expect(again).toMatchObject({ status: "DEFERRED", nextAllowedAt: "2026-10-20T09:00:00-03:00" });
    expect(await world.stores.connector.conversations.getMessage("op-4471", result.messageId)).toMatchObject({ status: "DISCARDED", policy: { decision: "DEFER", ruleIds: ["CP-ONE-PER-DAY"] } });
    const moved = again.messageId ?? "";
    const timer = world.armed.at(-1);
    expect(timer).toMatchObject({ timerId: moved, dueAtSim: "2026-10-20T09:00:00-03:00", reason: "CP-ONE-PER-DAY" });

    const fired = await resendDeferred(world.deps, world.call(), { operationId: "op-4471", messageId: moved, timerKey: `TIMER#DEFERRED_SEND#${moved}`, atSim: "2026-10-20T09:00:00-03:00" });
    expect(fired).toEqual({ status: "SENT", messageId: moved });
    const sent = await world.stores.connector.conversations.getMessage("op-4471", moved);
    expect(sent?.status).toBe("DELIVERED");
    expect(sent?.buttons.find((button) => button.action === "UPLOAD")?.url).toBe(deferred?.buttons.find((button) => button.action === "UPLOAD")?.url);
    expect(world.uploads).toHaveLength(1);
  });
});

describe("an ordered send (OUTBOUND_SEND)", () => {
  it("is the firm's message under its author, with the id derived from the event, sent once", async () => {
    await world.inbound("¿Hay novedades?", "2026-10-15T09:30:00-03:00");
    const event = { type: "OUTBOUND_SEND" as const, eventId: "evt_01JQORDERED000000000000001", operationId: "op-4471", clockId: "GLOBAL#firm-delta", firmId: "firm-delta", eventAtSim: THU_10_AR, author: "BROKER:brk-ana", kind: "BROKER_MESSAGE" as const, channel: "WHATSAPP" as const, text: "Hola Lucía, mañana te llamamos." };
    const call = { ...world.call(), actor: "BROKER:brk-ana" };
    expect(await sendOrdered(world.deps, event, call)).toMatchObject({ status: "SENT", messageId: orderedMessageId(event.eventId) });
    expect(await sendOrdered(world.deps, event, call)).toMatchObject({ status: "SENT", replayed: true });
    expect(world.g2.calls).toEqual([]);
    expect(await world.stores.connector.conversations.getMessage("op-4471", orderedMessageId(event.eventId))).toMatchObject({ author: "BROKER:brk-ana", status: "DELIVERED" });
  });
});
