import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, FIRM, REAL_NOW, START_SIM } from "../connector/testing";
import { type ConsoleWorld, DIEGO, MARTINA, PABLO, consoleWorld } from "./testing";

describe("operations router", () => {
  let world: ConsoleWorld;

  beforeEach(async () => {
    world = await consoleWorld();
  });

  it("[FL-080] lists the operations of the firm's world with documents, escalations and the process-error flag", async () => {
    const { operations, world: state } = world.stores.connector;
    await operations.openEscalation({ operationId: "op-4471", firmId: FIRM, clockId: CLOCK, reason: "OTHER", summary: "Revisar", openedAtSim: START_SIM, openedBy: "AGENT" });
    await state.recordProcessError({ operationId: "op-4471", clockId: CLOCK, eventId: "evt-1", type: "AGENT_TURN", atReal: REAL_NOW });
    const list = await world.caller(MARTINA).operations.list({});
    expect(list.clockId).toBe(CLOCK);
    expect(list.operations).toHaveLength(1);
    expect(list.operations[0]).toMatchObject({
      operationId: "op-4471",
      operationNumber: "4471",
      importerName: "Norpampa Insumos SRL",
      supplierName: "Qingdao Bluewave Textiles Co., Ltd.",
      dossierStatus: "OPEN",
      control: "AGENT",
      openEscalations: 1,
      processError: true,
    });
    expect(list.operations[0]?.documents.map((document) => document.status)).toEqual(["MISSING", "MISSING", "MISSING"]);
    expect((await world.caller(MARTINA).operations.list({ statuses: ["APPROVED"] })).operations).toEqual([]);
  });

  it("[FL-080] shows another firm nothing of this one", async () => {
    expect((await world.caller(PABLO).operations.list({})).operations).toEqual([]);
    await expect(world.caller(PABLO).operations.list({ clockId: CLOCK })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("[FL-081] returns the dossier with masked parties and no storage keys", async () => {
    const dossier = await world.caller(DIEGO).operations.get({ operationId: "op-4471" });
    expect(dossier.operation).toMatchObject({ operationId: "op-4471", eta: "2026-10-22T08:00:00-03:00", invoiceNumber: "QBT-2026-0917" });
    expect(dossier.importer).toMatchObject({ importerId: "imp-norpampa", phoneMasked: "+54*******0101" });
    expect(dossier.supplier.contacts).toEqual([expect.objectContaining({ contactId: "ctc-qingdao-1", emailMasked: "s***@sim.legajo.demo.craftech.io", status: "ACTIVE" })]);
    expect(dossier.processError).toBeNull();
    expect(JSON.stringify(dossier)).not.toMatch(/5550 ?0101|supplier-qingdao@|s3Key|sha256/);
  });

  it("[FL-081] builds the timeline in simulated order with pending timers and their reason", async () => {
    const { conversations, timers } = world.stores.connector;
    const base = { operationId: "op-4471", firmId: FIRM, clockId: CLOCK, channel: "WHATSAPP" as const, counterpart: "IMPORTER" as const, importerId: "imp-norpampa", sentAtReal: REAL_NOW };
    await conversations.appendMessage({ ...base, messageId: "msg-02", direction: "IN", status: "RECEIVED", author: "IMPORTER", to: "simulated", from: "+5491155500101", body: "Los manda el proveedor", sentAtSim: "2026-10-15T10:05:00-03:00" });
    await conversations.appendMessage({ ...base, messageId: "msg-01", direction: "OUT", kind: "DOCS_REQUEST", status: "SENT", author: "AGENT", to: "+5491155500101", from: "simulated", body: "Faltan documentos", sentAtSim: "2026-10-15T10:00:00-03:00" });
    await conversations.appendTurnNote({ turnId: "turn-1", operationId: "op-4471", clockId: CLOCK, trigger: "MILESTONE", text: "Pedido inicial enviado.", atSim: "2026-10-15T10:00:01-03:00", atReal: REAL_NOW });
    await timers.createTimer({ operationId: "op-4471", clockId: CLOCK, kind: "MILESTONE", timerId: "FOLLOWUP", dueAtSim: "2026-10-17T10:00:00-03:00", status: "SCHEDULED", reason: "Recordatorio" });
    const timeline = await world.caller(MARTINA).operations.timeline({ operationId: "op-4471" });
    expect(timeline.entries.map((entry) => entry.type)).toEqual(["MESSAGE", "NOTE", "MESSAGE"]);
    const first = timeline.entries[0];
    expect(first?.type === "MESSAGE" && first.message).toMatchObject({ messageId: "msg-01", to: "+54*******0101", kind: "DOCS_REQUEST" });
    expect(timeline.pending).toEqual([{ kind: "MILESTONE", timerId: "FOLLOWUP", dueAtSim: "2026-10-17T13:00:00.000Z", reason: "Recordatorio" }]);
  });

  it("[FL-081] signs a download link only for a version of the firm", async () => {
    await world.stores.connector.documents.addVersion({
      version: {
        operationId: "op-4471",
        clockId: CLOCK,
        docType: "PACKING_LIST",
        versionNo: 1,
        s3Key: "ops/op-4471/PACKING_LIST/v001-0a1b2c3d.pdf",
        sha256: "0".repeat(64),
        sizeBytes: 2048,
        source: { party: "IMPORTER", channel: "UPLOAD_LINK" },
        receivedAtSim: START_SIM,
        state: "RECEIVED",
      },
      document: { status: "RECEIVED" },
    });
    const link = await world.caller(DIEGO).operations.documentUrl({ docVersionId: "dv-4471-PL-1" });
    expect(link).toEqual({ url: "https://documents.s3.us-east-1.amazonaws.com/ops/op-4471/PACKING_LIST/v001-0a1b2c3d.pdf?download=4471-PL-v1.pdf", expiresInSec: 300 });
    await expect(world.caller(PABLO).operations.documentUrl({ docVersionId: "dv-4471-PL-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(world.caller(DIEGO).operations.documentUrl({ docVersionId: "dv-4471-CO-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
