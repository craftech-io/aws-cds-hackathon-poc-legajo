import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, FIRM, REAL_NOW, START_SIM } from "../../connector/testing";
import { gatewayContext } from "../common/principal";
import { type ToolWorld, OPERATION, toolWorld } from "../common/testing";
import { createOperationsTarget } from "./index";
import { CHECKLIST_COVERAGE_NOTE, nextMilestoneOf } from "./reads";
import { FIRM_NAME, createTestObservation, fileTestVersion, seedFirm } from "./testing";
import { textAr, textInZone } from "./time-text";


describe("operations target: the reads of the turn's operation", () => {
  let world: ToolWorld;
  let token: string;

  async function call(tool: string, input: Record<string, unknown> = {}) {
    return createOperationsTarget(world.deps).handle({ sessionToken: token, ...input }, gatewayContext(`operations___${tool}`));
  }

  beforeEach(async () => {
    world = await toolWorld();
    await seedFirm(world.stores);
    token = (await world.openTurn("IMPORTER_MESSAGE")).token;
  });

  it("get_operation: the operation, its parties, the ETA and the simulated now, already formatted", async () => {
    const result = await call("get_operation");
    expect(result).toMatchObject({
      ok: true,
      operation: {
        operationNumber: "4471",
        firmName: FIRM_NAME,
        importer: { name: "Norpampa Insumos SRL", contactFirstName: "Lucía" },
        supplier: { country: "CN", timezone: "Asia/Shanghai", language: "en" },
        invoiceNumber: "QBT-2026-0917",
        incoterm: "FOB",
        eta: "2026-10-22T08:00:00-03:00",
        etaText: "22/10 08:00",
        dossierStatus: "OPEN",
        control: "AGENT",
        dispatch: { status: "NONE" },
      },
      nowSim: START_SIM,
      nowSimText: "14/10 10:30",
    });
    // The importer's phone never goes out of this tool.
    expect(JSON.stringify(result)).not.toContain("+549");
  });

  it("get_dossier: documents, missing, deadlines in each party's clock, next milestone and open escalations", async () => {
    const v1 = await fileTestVersion(world.stores, { docType: "PACKING_LIST", reading: { readingId: "r1", status: "RECOGNIZED", docType: "PACKING_LIST", readerVersion: "1" } });
    await world.stores.connector.documents.updateDocument(OPERATION, "PACKING_LIST", { status: "WITH_OBSERVATION" });
    await createTestObservation(world.stores, { docType: "PACKING_LIST", code: "GROSS_WEIGHT_MISMATCH", docVersionId: v1.docVersionId });
    await world.stores.connector.operations.openEscalation({ operationId: OPERATION, firmId: FIRM, clockId: CLOCK, reason: "IMPORTER_ASKED", summary: "Pidió hablar con el estudio", openedAtSim: START_SIM, openedBy: "SYSTEM" });

    const result = await call("get_dossier");
    expect(result).toMatchObject({
      ok: true,
      complete: false,
      missing: ["COMMERCIAL_INVOICE", "CERTIFICATE_OF_ORIGIN"],
      deadlines: {
        importer: { atSim: "2026-10-19T10:00:00-03:00", text: "19/10 10:00" },
        supplier: { atSim: "2026-10-18T06:00:00-03:00", text: "2026-10-18 17:00 (Asia/Shanghai)", timezone: "Asia/Shanghai" },
      },
      nextMilestone: { name: "DOCS_REQUEST", text: "15/10 10:00" },
      openEscalations: 1,
    });
    if (!result.ok) throw new Error("expected ok");
    const documents = result["documents"] as { docType: string; status: string; currentDocVersionId?: string; observations: { code: string; attempts: number; label: string }[] }[];
    expect(documents.map((document) => document.docType)).toEqual(["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"]);
    expect(documents[1]).toMatchObject({ status: "WITH_OBSERVATION", currentDocVersionId: v1.docVersionId, observations: [{ code: "GROSS_WEIGHT_MISMATCH", attempts: 0, label: "peso bruto distinto del de la factura" }] });
  });

  it("get_dossier: complete only when the three documents are VALID", async () => {
    for (const docType of ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] as const) await world.stores.connector.documents.updateDocument(OPERATION, docType, { status: "VALID", validatedBy: "READER" });
    expect(await call("get_dossier")).toMatchObject({ ok: true, complete: true, missing: [] });
  });

  it("the next milestone comes from the scheduled timers, and none once they all fired", () => {
    const timer = (timerId: string, dueAtSim: string) => ({ timerId, dueAtSim }) as never;
    expect(nextMilestoneOf("2026-10-22T08:00:00-03:00", [timer("FOLLOWUP", "2026-10-17T10:00:00-03:00"), timer("ARRIVAL", "2026-10-22T08:00:00-03:00")], START_SIM)).toEqual({ name: "FOLLOWUP", dueAtSim: "2026-10-17T10:00:00-03:00" });
    expect(nextMilestoneOf("2026-10-22T08:00:00-03:00", [], "2026-10-23T08:00:00-03:00")).toBeUndefined();
  });

  it("get_checklist: the latest version of each document, filtered by type, with the coverage note", async () => {
    expect(await call("get_checklist", { docType: "PACKING_LIST" })).toEqual({
      ok: true,
      firmName: FIRM_NAME,
      checklistVersion: "PL v2",
      items: [{ itemId: "PL-02", docType: "PACKING_LIST", text: "Cantidad de bultos declarada", required: true }],
      coverageNote: CHECKLIST_COVERAGE_NOTE,
    });
    const all = await call("get_checklist");
    expect(all).toMatchObject({ ok: true, checklistVersion: "PL v2 · CO v1" });
    expect(await call("get_checklist", { docType: "COMMERCIAL_INVOICE" })).toMatchObject({ ok: true, items: [], checklistVersion: "" });
  });

  it("get_dispatch_status: NONE before customs, then the status with the firm's generic explanation", async () => {
    expect(await call("get_dispatch_status")).toEqual({ ok: true, status: "NONE" });
    await world.stores.connector.operations.recordDispatch({ operationId: OPERATION, status: "CANAL_ASIGNADO", channel: "NARANJA", occurredAtSim: "2026-10-23T11:00:00-03:00" });
    expect(await call("get_dispatch_status")).toEqual({ ok: true, status: "CANAL_ASIGNADO", channel: "NARANJA", occurredAtText: "23/10 11:00", genericExplanation: "La aduana va a revisar la documentación." });
    await world.stores.connector.operations.recordDispatch({ operationId: OPERATION, status: "LIBERADO", occurredAtSim: "2026-10-24T11:00:00-03:00" });
    // Without a Reference row the copy's glossary answers.
    expect(await call("get_dispatch_status")).toMatchObject({ ok: true, status: "LIBERADO", genericExplanation: "Significa que la aduana terminó el trámite de esta operación." });
  });

  it("get_counterpart_profile IMPORTER: opt-in, window from the importer's last WhatsApp, authorization and other open operations", async () => {
    const { parties, conversations } = world.stores.connector;
    await parties.grantConsent({ importerId: "imp-norpampa", medium: "SIGNED_FORM", textVersion: "v1", atSim: "2026-10-01T09:00:00-03:00", by: "SEED" });
    await parties.setAuthorization({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: true, atSim: "2026-10-01T09:00:00-03:00", by: "SEED" });
    await conversations.appendMessage({
      messageId: "msg-01J9ZQIN",
      operationId: OPERATION,
      firmId: FIRM,
      clockId: CLOCK,
      channel: "WHATSAPP",
      counterpart: "IMPORTER",
      importerId: "imp-norpampa",
      direction: "IN",
      status: "RECEIVED",
      author: "IMPORTER",
      to: "simulated",
      from: "simulated",
      body: "Hola",
      sentAtSim: "2026-10-14T09:00:00-03:00",
      sentAtReal: REAL_NOW,
    });
    expect(await call("get_counterpart_profile", { party: "IMPORTER" })).toEqual({
      ok: true,
      importer: {
        contactFirstName: "Lucía",
        optIn: { active: true, grantedAtText: "01/10 09:00" },
        windowOpen: true,
        windowClosesAtText: "15/10 09:00",
        supplierContactAuthorized: true,
        otherOpenOperations: ["4472"],
      },
    });
  });

  it("get_counterpart_profile IMPORTER: no message, no consent, no authorization → closed and false", async () => {
    expect(await call("get_counterpart_profile", { party: "IMPORTER" })).toMatchObject({ ok: true, importer: { optIn: { active: false }, windowOpen: false, supplierContactAuthorized: false } });
  });

  it("get_counterpart_profile SUPPLIER: local time, business hours of its zone and masked contacts", async () => {
    const result = await call("get_counterpart_profile", { party: "SUPPLIER" });
    expect(result).toMatchObject({
      ok: true,
      supplier: {
        name: "Qingdao Bluewave Textiles Co., Ltd.",
        timezone: "Asia/Shanghai",
        localTimeText: textInZone(START_SIM, "Asia/Shanghai"),
        businessHoursOpenNow: false,
        nextBusinessOpenText: "2026-10-15 09:00 (Asia/Shanghai)",
        contacts: [{ contactId: "ctc-qingdao-1", emailMasked: "s***@sim.legajo.demo.craftech.io", status: "ACTIVE", confirmed: true }],
        profile: { lateDocTypes: [] },
      },
    });
    expect(JSON.stringify(result)).not.toContain("supplier-qingdao@");
  });

  it("formats dates on Argentina's clock for the firm and on the supplier's for the supplier", () => {
    expect(textAr("2026-10-18T09:00:00Z")).toBe("18/10 06:00");
    expect(textInZone("2026-10-18T09:00:00Z", "Asia/Shanghai")).toBe("2026-10-18 17:00 (Asia/Shanghai)");
  });
});
