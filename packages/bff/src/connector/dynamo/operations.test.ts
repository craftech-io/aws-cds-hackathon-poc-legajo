import { beforeEach, describe, expect, it } from "vitest";
import { controlAt, dossierStatusAt } from "../../domain/operations";
import type { MemoryStores } from "../memory/index";
import { CLOCK, FIRM, START_SIM, THREAD_TAG, hashOf, memoryStores, operationFixture, seedDemoSlice } from "../testing";

const AT = "2026-10-16T09:10:00-03:00";

describe("operations: creation, thread and dossier", () => {
  let stores: MemoryStores;

  beforeEach(async () => {
    stores = memoryStores();
    await seedDemoSlice(stores);
  });

  it("creates the operation with its three documents, histories, GSI keys and thread claim, all or nothing", async () => {
    const { operations, documents, parties } = stores.connector;
    const operation = await operations.getOperation("op-4471");
    expect(operation).toMatchObject({ dossierStatus: "OPEN", control: "AGENT", sessionEpoch: 0, dispatch: { status: "NONE", history: [] }, threadTag: THREAD_TAG });
    expect(operation.dossierHistory).toEqual([{ atSim: START_SIM, by: "SEED", status: "OPEN" }]);
    expect(operation.etaHistory).toEqual([{ eta: "2026-10-22T08:00:00-03:00", atSim: START_SIM, source: "SEED" }]);
    expect(await stores.client.get("Operations", { PK: "OP#op-4471", SK: "META" })).toMatchObject({
      firmStatusKey: "FIRM#firm-delta#OPEN",
      etaSort: "2026-10-22T11:00:00.000Z",
      threadKey: "THREAD#4471-k7p2q9",
    });
    expect((await documents.listDocuments("op-4471")).map((doc) => [doc.docType, doc.status, doc.currentVersion])).toEqual([
      ["CERTIFICATE_OF_ORIGIN", "MISSING", 0],
      ["COMMERCIAL_INVOICE", "MISSING", 0],
      ["PACKING_LIST", "MISSING", 0],
    ]);
    expect((await parties.getAddressClaim(hashOf(operation.threadAddress)))?.ownerType).toBe("OPERATION");

    // The same thread address in another world is a collision: nothing of the second operation is written.
    const clone = operationFixture({ operationId: "op-4471-g01", clockId: "GUEST#firm-guest-01", firmId: "firm-guest-01" });
    await expect(operations.createOperation({ ...clone, threadClaimHash: hashOf(clone.threadAddress) })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await operations.findOperation("op-4471-g01")).toBeUndefined();
    expect(await documents.listDocuments("op-4471-g01")).toEqual([]);
    await expect(operations.createOperation({ ...operationFixture(), operationId: "op-4472", threadAddress: "op-4472-k7p2q9@legajo.demo.craftech.io" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("resolves an email thread by number and tag, and only that one", async () => {
    const { operations } = stores.connector;
    expect(await operations.findOperationByThread("4471", THREAD_TAG)).toMatchObject({ status: "UNIQUE", value: { operationId: "op-4471" } });
    expect(await operations.findOperationByThread("4471", "zzzzzz")).toEqual({ status: "NONE" });
  });

  it("lists a firm's operations by status, importer and world, sorted by ETA", async () => {
    const { operations } = stores.connector;
    await operations.createOperation(operationFixture({ operationId: "op-4478", operationNumber: "4478", threadTag: "m3n4p5", eta: "2026-10-19T08:00:00-03:00", supplierId: "sup-ligurmare" }));
    expect((await operations.listOperations(FIRM)).map((operation) => operation.operationId)).toEqual(["op-4478", "op-4471"]);
    expect(await operations.listOperations(FIRM, { statuses: ["APPROVED"] })).toEqual([]);
    expect(await operations.listOperations(FIRM, { importerId: "imp-cuyo" })).toEqual([]);
    expect(await operations.listOperations(FIRM, { clockId: CLOCK, statuses: ["OPEN"] })).toHaveLength(2);
  });

  it("moves the dossier only along its transitions, pinned to the version read, with a dated history", async () => {
    const { operations } = stores.connector;
    await expect(operations.transitionDossier({ operationId: "op-4471", to: "APPROVED", approvedBy: "brk-delta-diego", atSim: AT, by: "BROKER:brk-delta-diego" })).rejects.toMatchObject({ code: "VALIDATION" });
    const ready = await operations.transitionDossier({ operationId: "op-4471", to: "READY_FOR_REVIEW", atSim: AT, by: "AGENT", expectedVersion: 1 });
    expect(ready).toMatchObject({ dossierStatus: "READY_FOR_REVIEW", version: 2 });
    expect((await stores.client.get("Operations", { PK: "OP#op-4471", SK: "META" }))?.firmStatusKey).toBe("FIRM#firm-delta#READY_FOR_REVIEW");
    await expect(operations.transitionDossier({ operationId: "op-4471", to: "APPROVED", approvedBy: "brk-delta-diego", atSim: AT, by: "BROKER:brk-delta-diego", expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(operations.transitionDossier({ operationId: "op-4471", to: "APPROVED", atSim: AT, by: "BROKER:brk-delta-diego" })).rejects.toMatchObject({ code: "VALIDATION" });
    const approved = await operations.transitionDossier({ operationId: "op-4471", to: "APPROVED", approvedBy: "brk-delta-diego", atSim: "2026-10-18T11:00:00-03:00", by: "BROKER:brk-delta-diego" });
    expect(approved).toMatchObject({ dossierStatus: "APPROVED", approvedBy: "brk-delta-diego", approvedAtSim: "2026-10-18T11:00:00-03:00" });
    expect(approved.dossierHistory.map((event) => event.status)).toEqual(["OPEN", "READY_FOR_REVIEW", "APPROVED"]);
    expect(dossierStatusAt(approved, "2026-10-17T00:00:00-03:00")).toBe("READY_FOR_REVIEW");
    expect(await operations.listOperations(FIRM, { statuses: ["APPROVED"] })).toHaveLength(1);
  });

  it("records who took and released the conversation and when", async () => {
    const { operations } = stores.connector;
    const taken = await operations.setControl({ operationId: "op-4471", control: "BROKER", atSim: AT, by: "BROKER:brk-delta-martina" });
    expect(await operations.setControl({ operationId: "op-4471", control: "BROKER", atSim: AT, by: "BROKER:brk-delta-martina" })).toEqual(taken);
    const released = await operations.setControl({ operationId: "op-4471", control: "AGENT", atSim: "2026-10-16T09:40:00-03:00", by: "BROKER:brk-delta-martina", expectedVersion: taken.version });
    expect(released.controlHistory.map((event) => event.control)).toEqual(["AGENT", "BROKER", "AGENT"]);
    expect(controlAt(released, "2026-10-16T09:20:00-03:00")).toBe("BROKER");
  });

  it("changes the ETA once per carrier event, keeping the previous one", async () => {
    const { operations } = stores.connector;
    const change = { operationId: "op-4471", eta: "2026-10-20T08:00:00-03:00", atSim: "2026-10-16T09:30:00-03:00", source: "CARRIER" as const, eventId: "evt-01" };
    const moved = await operations.changeEta(change);
    expect(moved.eta).toBe("2026-10-20T08:00:00-03:00");
    expect(moved.etaHistory[1]).toMatchObject({ previousEta: "2026-10-22T08:00:00-03:00", eventId: "evt-01" });
    expect(await operations.changeEta(change)).toEqual(moved);
    expect((await stores.client.get("Operations", { PK: "OP#op-4471", SK: "META" }))?.etaSort).toBe("2026-10-20T11:00:00.000Z");
  });

  it("records customs statuses once each and raises the session epoch atomically", async () => {
    const { operations } = stores.connector;
    const customs = { operationId: "op-4471", status: "CANAL_ASIGNADO" as const, channel: "NARANJA" as const, occurredAtSim: "2026-10-21T11:00:00-03:00", eventId: "evt-02" };
    const dispatched = await operations.recordDispatch(customs);
    expect(dispatched.dispatch).toMatchObject({ status: "CANAL_ASIGNADO", channel: "NARANJA", history: [{ status: "CANAL_ASIGNADO", eventId: "evt-02" }] });
    expect((await operations.recordDispatch(customs)).dispatch.history).toHaveLength(1);
    expect(await operations.nextSessionEpoch("op-4471")).toBe(1);
    expect(await operations.nextSessionEpoch("op-4471")).toBe(2);
    const behaviour = await operations.updateOperation("op-4471", { simBehaviour: "SEEDED_ERROR_TWICE" });
    expect(behaviour.simBehaviour).toBe("SEEDED_ERROR_TWICE");
    await expect(operations.updateOperation("op-4471", { simBehaviour: "SOMETHING" as never })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("keeps one open escalation per reason and operation, and resolves it once", async () => {
    const { operations } = stores.connector;
    const escalation = { operationId: "op-4471", firmId: FIRM, clockId: CLOCK, reason: "OBSERVATION_ATTEMPTS" as const, summary: "Segundo intento fallido del packing list", openedAtSim: AT, openedBy: "SYSTEM" as const };
    const first = await operations.openEscalation(escalation);
    expect(first).toMatchObject({ created: true, escalation: { escalationId: "esc-observation-attempts-1", status: "OPEN" } });
    expect(await operations.openEscalation(escalation)).toMatchObject({ created: false, escalation: { escalationId: "esc-observation-attempts-1" } });
    await operations.openEscalation({ ...escalation, reason: "OUT_OF_CHECKLIST", summary: "Pregunta fuera del checklist" });
    expect(await operations.listOpenEscalationsByFirm(FIRM)).toHaveLength(2);
    expect((await operations.markEscalationEmailed("op-4471", "esc-observation-attempts-1")).emailSent).toBe(true);
    const resolved = await operations.resolveEscalation({ operationId: "op-4471", escalationId: "esc-observation-attempts-1", atSim: "2026-10-16T12:00:00-03:00", by: "BROKER:brk-delta-diego" });
    expect(resolved).toMatchObject({ status: "RESOLVED", resolvedBy: "BROKER:brk-delta-diego" });
    await expect(operations.resolveEscalation({ operationId: "op-4471", escalationId: "esc-observation-attempts-1", atSim: AT, by: "BROKER:brk-delta-diego" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await operations.openEscalation(escalation)).toMatchObject({ created: true, escalation: { escalationId: "esc-observation-attempts-2" } });
    await expect(operations.openEscalation({ ...escalation, firmId: "firm-norte" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("operations: documents, versions and observations", () => {
  let stores: MemoryStores;
  const version = {
    operationId: "op-4471",
    clockId: CLOCK,
    docType: "PACKING_LIST" as const,
    versionNo: 1,
    s3Key: "ops/op-4471/PACKING_LIST/v001-0a1b2c3d.pdf",
    sha256: hashOf("pl-v1"),
    sizeBytes: 48_213,
    source: { party: "SUPPLIER" as const, channel: "EMAIL" as const, contactId: "ctc-qingdao-1" },
    receivedAtSim: "2026-10-15T22:10:00-03:00",
    state: "RECEIVED" as const,
    readerAttempts: 0,
  };

  beforeEach(async () => {
    stores = memoryStores();
    await seedDemoSlice(stores);
  });

  it("adds version n + 1 and moves the document to it in one write, refusing a stale or skipped number", async () => {
    const { documents } = stores.connector;
    const added = await documents.addVersion({ version, document: { status: "RECEIVED" }, expectedDocumentVersion: 1 });
    expect(added.version).toMatchObject({ docVersionId: "dv-4471-PL-1", versionNo: 1 });
    expect(added.document).toMatchObject({ status: "RECEIVED", currentVersion: 1, currentDocVersionId: "dv-4471-PL-1", receivedAtSim: "2026-10-15T22:10:00-03:00", version: 2 });
    expect(await stores.client.get("Operations", { PK: "OP#op-4471", SK: "DOC#PACKING_LIST#V#001" })).toMatchObject({ entity: "DocumentVersion" });
    await expect(documents.addVersion({ version })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(documents.addVersion({ version: { ...version, versionNo: 3 } })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(documents.addVersion({ version: { ...version, versionNo: 2 }, expectedDocumentVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await documents.findVersion("dv-4471-PL-1"))?.sha256).toBe(hashOf("pl-v1"));
    expect(await documents.findVersion("dv-4471-CO-1")).toBeUndefined();
    expect(await documents.findVersion("not-an-id")).toBeUndefined();
  });

  it("stores the reading as the reader returned it and the document status pinned to its version", async () => {
    const { documents } = stores.connector;
    await documents.addVersion({ version, document: { status: "RECEIVED" } });
    const reading = {
      readingId: "rd-1",
      status: "RECOGNIZED" as const,
      docType: "PACKING_LIST" as const,
      matchedBy: "SHA256" as const,
      confidence: 0.97,
      fields: { invoiceNumber: "QBT-2026-0917", grossWeightKg: 12480 },
      observations: [{ code: "GROSS_WEIGHT_MISMATCH" as const, severity: "BLOCKING" as const, field: "grossWeightKg", expected: "12840", found: "12480", againstDocType: "COMMERCIAL_INVOICE" as const }],
      readerVersion: "1.0.0",
    };
    const read = await documents.updateVersion("op-4471", "PACKING_LIST", 1, { state: "READ", reading, readAtSim: "2026-10-15T22:10:00-03:00", readerAttempts: 1 });
    expect(read.reading?.observations).toHaveLength(1);
    const doc = await documents.getDocument("op-4471", "PACKING_LIST");
    await expect(documents.updateDocument("op-4471", "PACKING_LIST", { status: "WITH_OBSERVATION" }, doc.version - 1)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await documents.updateDocument("op-4471", "PACKING_LIST", { status: "WITH_OBSERVATION", responsibleParty: "SUPPLIER" }, doc.version)).status).toBe("WITH_OBSERVATION");
    await expect(documents.updateDocument("op-4471", "PACKING_LIST", { status: "LOST" as never })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("opens one observation per document and code, counts attempts and keeps its status history", async () => {
    const { documents } = stores.connector;
    const observation = {
      observationId: "obs-4471-PL-GROSS_WEIGHT_MISMATCH",
      operationId: "op-4471",
      clockId: CLOCK,
      docType: "PACKING_LIST" as const,
      code: "GROSS_WEIGHT_MISMATCH" as const,
      severity: "BLOCKING" as const,
      expected: "12840",
      found: "12480",
      status: "OPEN" as const,
      firstDocVersionId: "dv-4471-PL-1",
      lastDocVersionId: "dv-4471-PL-1",
      created: { atSim: "2026-10-15T22:10:00-03:00", by: "SYSTEM" as const },
    };
    const opened = await documents.createObservation(observation);
    expect(opened).toMatchObject({ attempts: 0, flaggedForReview: false, history: [{ status: "OPEN", docVersionId: "dv-4471-PL-1" }] });
    await expect(documents.createObservation(observation)).rejects.toMatchObject({ code: "CONFLICT" });
    const assigned = await documents.updateObservation("op-4471", observation.observationId, { responsibleParty: "SUPPLIER", matrixDefault: "SUPPLIER", matchesMatrix: true, rationale: "El proveedor emite el packing list" });
    const requested = await documents.transitionObservation({ operationId: "op-4471", observationId: observation.observationId, to: "CORRECTION_REQUESTED", countAttempt: true, atSim: "2026-10-15T22:11:00-03:00", by: "AGENT", expectedVersion: assigned.version });
    expect(requested).toMatchObject({ status: "CORRECTION_REQUESTED", attempts: 1, responsibleParty: "SUPPLIER" });
    await expect(documents.transitionObservation({ operationId: "op-4471", observationId: observation.observationId, to: "RESOLVED", atSim: AT, by: "SYSTEM", expectedVersion: assigned.version })).rejects.toMatchObject({ code: "CONFLICT" });
    const resolved = await documents.transitionObservation({ operationId: "op-4471", observationId: observation.observationId, to: "RESOLVED", docVersionId: "dv-4471-PL-2", atSim: AT, by: "SYSTEM" });
    expect(resolved).toMatchObject({ status: "RESOLVED", lastDocVersionId: "dv-4471-PL-2", attempts: 1 });
    expect(resolved.history.map((event) => event.status)).toEqual(["OPEN", "CORRECTION_REQUESTED", "RESOLVED"]);
    expect(await documents.listObservations("op-4471", { statuses: ["OPEN", "CORRECTION_REQUESTED"] })).toEqual([]);
    expect(await documents.listObservations("op-4471", { docType: "PACKING_LIST" })).toHaveLength(1);
  });
});
