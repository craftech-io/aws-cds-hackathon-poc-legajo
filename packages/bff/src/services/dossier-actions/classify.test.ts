import { describe, expect, it } from "vitest";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { CLOCK, FIRM, OPERATION, START_SIM, type ServiceWorld, consoleCaller, fileVersion, serviceWorld, setDocuments } from "../operations-admin/testing";
import { classifyUnrecognizedHandler } from "./classify";

async function unrecognized(world: ServiceWorld): Promise<string> {
  const docVersionId = await fileVersion(world, "CERTIFICATE_OF_ORIGIN", "UNRECOGNIZED");
  await world.stores.connector.operations.openEscalation({ operationId: OPERATION, firmId: FIRM, clockId: CLOCK, reason: "UNRECOGNIZED_DOCUMENT", summary: "documento que el lector no reconoce", openedAtSim: START_SIM, openedBy: "SYSTEM", docVersionId });
  return docVersionId;
}

describe("classify_unrecognized [FL-044]", () => {
  it("[FL-044] a person classifies the version: CLASSIFIED with classifiedBy, the document VALID without a reading, the escalation resolved", async () => {
    const world = await serviceWorld();
    const docVersionId = await unrecognized(world);
    await setDocuments(world, { COMMERCIAL_INVOICE: "VALID", PACKING_LIST: "VALID" });
    const answer = unwrapDirect(await classifyUnrecognizedHandler(world.deps)({ caller: consoleCaller(FIRM, "ANALYST"), operationId: OPERATION, docVersionId, outcome: "CLASSIFY", docType: "CERTIFICATE_OF_ORIGIN" }));
    expect(answer).toMatchObject({ outcome: "CLASSIFY", classifiedAs: "CERTIFICATE_OF_ORIGIN", documentStatus: "VALID", approvalRequested: true });
    const version = await world.stores.connector.documents.findVersion(docVersionId);
    expect(version).toMatchObject({ state: "CLASSIFIED", classifiedAs: "CERTIFICATE_OF_ORIGIN", classifiedBy: "BROKER:brk-delta-martina" });
    expect(await world.stores.connector.operations.listEscalations(OPERATION, { status: "OPEN" })).toEqual([]);
    const row = (await world.stores.connector.audit.listByOperation(OPERATION)).find((decision) => decision.action === "DOCUMENT_CLASSIFIED");
    expect(row?.detail).toMatchObject({ reading: "NONE", validatedBy: "HUMAN_CLASSIFICATION" });
  });

  it("[FL-044] a discard moves no document", async () => {
    const world = await serviceWorld();
    const docVersionId = await unrecognized(world);
    const answer = unwrapDirect(await classifyUnrecognizedHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION, docVersionId, outcome: "DISCARD" }));
    expect(answer).toMatchObject({ outcome: "DISCARD", approvalRequested: false });
    expect(await world.stores.connector.documents.findVersion(docVersionId)).toMatchObject({ state: "DISCARDED", discardedBy: "BROKER:brk-delta-diego" });
    expect((await world.stores.connector.documents.getDocument(OPERATION, "CERTIFICATE_OF_ORIGIN")).status).toBe("MISSING");
  });

  it("refuses a version that was read, one of another operation and a second decision", async () => {
    const world = await serviceWorld();
    const read = await fileVersion(world, "PACKING_LIST", "READ");
    const classify = classifyUnrecognizedHandler(world.deps);
    expect(await classify({ caller: consoleCaller(), operationId: OPERATION, docVersionId: read, outcome: "DISCARD" })).toMatchObject({ ok: false, error: { code: "CONFLICT", reason: "VERSION_NOT_UNRECOGNIZED" } });
    expect(await classify({ caller: consoleCaller(), operationId: OPERATION, docVersionId: "dv-5501-CO-1", outcome: "DISCARD" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const docVersionId = await unrecognized(world);
    unwrapDirect(await classify({ caller: consoleCaller(), operationId: OPERATION, docVersionId, outcome: "DISCARD" }));
    expect(await classify({ caller: consoleCaller(), operationId: OPERATION, docVersionId, outcome: "CLASSIFY", docType: "CERTIFICATE_OF_ORIGIN" })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });
});
