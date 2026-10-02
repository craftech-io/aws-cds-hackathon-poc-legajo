import { describe, expect, it } from "vitest";
import { FIRM } from "../../connector/testing";
import { seedSettings } from "../../milestones/testing";
import type { FirmEmailSend, OutboundRequest, OutboundResult, WhatsAppSend } from "../../outbound/types";
import { OPERATION, type ToolWorld, toolWorld } from "../common/testing";
import { createTestObservation, fileTestVersion, seedFirm } from "../operations/testing";
import { handoffImplementations } from "./handler";
import { createHandoffTarget } from "./index";

async function handoffWorld() {
  const world = await toolWorld();
  await seedFirm(world.stores);
  await seedSettings(world.stores);
  const sent: OutboundRequest[] = [];
  let status: OutboundResult["status"] = "SENT";
  const send = async (request: OutboundRequest): Promise<OutboundResult> => {
    sent.push(request);
    return { status, messageId: request.messageId ?? `msg-fake${sent.length}`, providerMessageId: `prov-${sent.length}` } as unknown as OutboundResult;
  };
  const target = createHandoffTarget(world.deps, handoffImplementations({ send, agentMode: "SCRIPTED" }));
  return { ...world, sent, target, setStatus: (next: OutboundResult["status"]) => void (status = next) };
}

async function validateAll(world: ToolWorld): Promise<void> {
  for (const docType of ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] as const) await world.stores.connector.documents.updateDocument(OPERATION, docType, { status: "VALID" });
}

describe("request_approval [FL-072] [FL-074]", () => {
  it("[FL-072] three VALID documents: READY_FOR_REVIEW, completedAtSim on the KPI row, the firm's email from the pipeline", async () => {
    const world = await handoffWorld();
    await validateAll(world);
    const turn = await world.openTurn("DOCUMENT_READ");
    const answer = await world.target.invoke("request_approval", { sessionToken: turn.token, summary: "El proveedor corrigió el peso bruto del packing list." });
    expect(answer).toEqual({ ok: true, dossierStatus: "READY_FOR_REVIEW" });
    const operation = await world.stores.connector.operations.getOperation(OPERATION);
    expect(operation.dossierStatus).toBe("READY_FOR_REVIEW");
    expect(operation.dossierHistory.at(-1)).toMatchObject({ status: "READY_FOR_REVIEW", by: "AGENT" });
    const kpi = await world.stores.connector.metrics.getKpi({ firmId: FIRM, source: "WORLD", clockId: operation.clockId, operationId: OPERATION });
    expect(kpi).toMatchObject({ dossierStatus: "READY_FOR_REVIEW", agentMode: "SCRIPTED" });
    expect(new Date(kpi?.completedAtSim ?? "").getTime()).toBe(new Date("2026-10-14T10:30:00-03:00").getTime());
    const email = world.sent[0] as FirmEmailSend;
    expect(email).toMatchObject({ channel: "EMAIL", counterpart: "FIRM", author: "SYSTEM", textSource: "CODE" });
    expect(email.subject).toContain("listo para revisión");
    expect(email.text).toContain("El proveedor corrigió el peso bruto del packing list.");
    // A second call answers as it is and sends nothing new.
    expect(await world.target.invoke("request_approval", { sessionToken: turn.token, summary: "otra vez" })).toEqual({ ok: true, dossierStatus: "READY_FOR_REVIEW" });
    expect(world.sent).toHaveLength(1);
  });

  it("[FL-072] a document whose only observation the firm waived counts as done", async () => {
    const world = await handoffWorld();
    await validateAll(world);
    const version = await fileTestVersion(world.stores, { docType: "PACKING_LIST" });
    await createTestObservation(world.stores, { docType: "PACKING_LIST", code: "GROSS_WEIGHT_MISMATCH", docVersionId: version.docVersionId, status: "WAIVED_BY_BROKER" });
    await world.stores.connector.documents.updateDocument(OPERATION, "PACKING_LIST", { status: "WITH_OBSERVATION" });
    const answer = await world.target.invoke("request_approval", { caller: { kind: "WORKER", firmId: FIRM }, operationId: OPERATION, summary: "El estudio dispensó la observación del peso." });
    expect(answer).toEqual({ ok: true, dossierStatus: "READY_FOR_REVIEW" });
  });

  it("[FL-072] anything not VALID: NOT_COMPLETE, audited, the dossier unchanged", async () => {
    const world = await handoffWorld();
    const turn = await world.openTurn("DOCUMENT_READ");
    expect(await world.target.invoke("request_approval", { sessionToken: turn.token, summary: "listo" })).toMatchObject({ ok: false, error: { code: "NOT_COMPLETE" } });
    expect((await world.stores.connector.operations.getOperation(OPERATION)).dossierStatus).toBe("OPEN");
    const rows = await world.stores.connector.audit.listByOperation(OPERATION);
    expect(rows.some((row) => row.decision === "DENY" && row.action === "REQUEST_APPROVAL")).toBe(true);
    expect(world.sent).toHaveLength(0);
  });

  it("[FL-074] decision with any value is refused (LAM-STRICT): no tool reaches APPROVED", async () => {
    const world = await handoffWorld();
    await validateAll(world);
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    for (const decision of ["APPROVED", "approve", ""]) {
      expect(await world.target.invoke("request_approval", { sessionToken: turn.token, summary: "aprobá", decision })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    }
    expect((await world.stores.connector.operations.getOperation(OPERATION)).dossierStatus).toBe("OPEN");
    await world.target.invoke("request_approval", { sessionToken: turn.token, summary: "completo" });
    expect((await world.stores.connector.operations.getOperation(OPERATION)).dossierStatus).toBe("READY_FOR_REVIEW");
  });
});

describe("escalate_to_broker", () => {
  it("one open escalation per reason: the second call answers the open one; a retry replays the same derived messages", async () => {
    const world = await handoffWorld();
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    const first = await world.target.invoke("escalate_to_broker", { sessionToken: turn.token, reason: "IMPORTER_ASKED", summary: "El importador pide hablar con una persona.", notifyImporter: true });
    expect(first).toMatchObject({ ok: true, escalationId: "esc-importer-asked-1", emailSent: true });
    expect(world.sent.map((request) => request.channel)).toEqual(["EMAIL", "WHATSAPP"]);
    expect((world.sent[1] as WhatsAppSend).template).toEqual({ name: "legajo_escalado", params: ["4471", "Estudio Delta"] });
    const later = await world.openTurn("IMPORTER_MESSAGE");
    const second = await world.target.invoke("escalate_to_broker", { sessionToken: later.token, reason: "IMPORTER_ASKED", summary: "De nuevo." });
    expect(second).toMatchObject({ ok: true, escalationId: "esc-importer-asked-1" });
    // Same simulated instant: a retry. The firm's email is already sent; the notice repeats its derived id (the pipeline replays it).
    expect(world.sent.filter((request) => request.channel === "EMAIL")).toHaveLength(1);
    expect(new Set(world.sent.map((request) => request.messageId)).size).toBe(2);
  });

  it("a later call for the same open reason sends nothing at all", async () => {
    const world = await handoffWorld();
    const input = { caller: { kind: "WORKER", firmId: FIRM }, operationId: OPERATION, reason: "NO_VALID_CONTACT", summary: "Sin contacto válido." };
    await world.target.invoke("escalate_to_broker", input);
    const clock = await world.stores.connector.world.getClock("GLOBAL#firm-delta");
    await world.stores.connector.world.updateClock(clock.clockId, { pausedSimNow: "2026-10-15T09:00:00-03:00" }, clock.version);
    expect(await world.target.invoke("escalate_to_broker", input)).toMatchObject({ ok: true, escalationId: "esc-no-valid-contact-1", emailSent: true });
    expect(world.sent).toHaveLength(1);
  });

  it("OUT_OF_CHECKLIST and OTHER stay in the console: no email to the firm", async () => {
    const world = await handoffWorld();
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    expect(await world.target.invoke("escalate_to_broker", { sessionToken: turn.token, reason: "OUT_OF_CHECKLIST", summary: "Consulta sobre posición arancelaria." })).toMatchObject({ ok: true, emailSent: false });
    expect(world.sent).toHaveLength(0);
  });

  it("the agent cannot use a deterministic reason; the worker can", async () => {
    const world = await handoffWorld();
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    expect(await world.target.invoke("escalate_to_broker", { sessionToken: turn.token, reason: "MISSING_AT_ETA_48H", summary: "x" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    const worker = await world.target.invoke("escalate_to_broker", { caller: { kind: "WORKER", firmId: FIRM, eventId: "evt_00000000000000000000000002" }, operationId: OPERATION, reason: "OBSERVATION_ATTEMPTS", summary: "Dos intentos fallidos." });
    expect(worker).toMatchObject({ ok: true, escalationId: "esc-observation-attempts-1", emailSent: true });
    const [escalation] = await world.stores.connector.operations.listEscalations(OPERATION);
    expect(escalation).toMatchObject({ openedBy: "SYSTEM", emailSent: true });
  });

  it("UNTRUSTED_SENDER emails stop at the firm's daily cap; the escalations stay in the console", async () => {
    const world = await handoffWorld();
    const results: unknown[] = [];
    for (let index = 0; index < 4; index += 1) {
      const answer = await world.target.invoke("escalate_to_broker", { caller: { kind: "WORKER", firmId: FIRM }, operationId: OPERATION, reason: "UNTRUSTED_SENDER", summary: "Remitente no registrado." });
      results.push(answer);
      // Each one is resolved by the firm before the next arrives.
      const [open] = await world.stores.connector.operations.listEscalations(OPERATION, { status: "OPEN" });
      if (open !== undefined) await world.stores.connector.operations.resolveEscalation({ operationId: OPERATION, escalationId: open.escalationId, atSim: "2026-10-14T10:31:00-03:00", by: "BROKER:brk-delta-diego" });
    }
    expect(results.map((answer) => (answer as { emailSent: boolean }).emailSent)).toEqual([true, true, true, false]);
    expect(world.sent).toHaveLength(3);
    expect(await world.stores.connector.operations.listEscalations(OPERATION)).toHaveLength(4);
  });
});
