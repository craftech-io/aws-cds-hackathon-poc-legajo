import { describe, expect, it } from "vitest";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { FIRM, OPERATION, consoleCaller, fileVersion, openObservation, serviceWorld, setDocuments } from "../operations-admin/testing";
import { waiveObservationHandler } from "./waive";

describe("waive_observation [FL-043]", () => {
  it("[FL-043] waives with its reason, the document becomes VALID by waiver and, once complete, the approval is requested", async () => {
    const world = await serviceWorld();
    const docVersionId = await fileVersion(world, "PACKING_LIST", "READ");
    const observationId = await openObservation(world, "PACKING_LIST", docVersionId);
    await setDocuments(world, { COMMERCIAL_INVOICE: "VALID", PACKING_LIST: "WITH_OBSERVATION", CERTIFICATE_OF_ORIGIN: "VALID" });
    const answer = unwrapDirect(await waiveObservationHandler(world.deps)({ caller: consoleCaller(FIRM, "ANALYST"), operationId: OPERATION, observationId, reason: "Diferencia de redondeo aceptada por el estudio" }));
    expect(answer).toMatchObject({ status: "WAIVED_BY_BROKER", changed: true, documentStatus: "VALID", approvalRequested: true });
    const document = await world.stores.connector.documents.getDocument(OPERATION, "PACKING_LIST");
    expect(document).toMatchObject({ status: "VALID", validatedBy: "WAIVER" });
    const observation = await world.stores.connector.documents.getObservation(OPERATION, observationId);
    expect(observation).toMatchObject({ waiveReason: "Diferencia de redondeo aceptada por el estudio" });
    expect(observation.history.at(-1)).toMatchObject({ status: "WAIVED_BY_BROKER", by: "BROKER:brk-delta-martina" });
    expect(world.approvals).toMatchObject([{ operationId: OPERATION }]);
    const waived = (await world.stores.connector.audit.listByOperation(OPERATION)).find((row) => row.action === "WAIVED");
    expect(waived?.refs).toMatchObject({ observationId, brokerId: "brk-delta-martina" });
  });

  it("[FL-043] leaves the document with its observation when another blocking one remains, and asks for no approval", async () => {
    const world = await serviceWorld();
    const docVersionId = await fileVersion(world, "PACKING_LIST", "READ");
    const observationId = await openObservation(world, "PACKING_LIST", docVersionId);
    await world.stores.connector.documents.createObservation({ observationId: "obs-4471-PL-NET_WEIGHT_MISMATCH", operationId: OPERATION, clockId: "GLOBAL#firm-delta", docType: "PACKING_LIST", code: "NET_WEIGHT_MISMATCH", severity: "BLOCKING", status: "OPEN", firstDocVersionId: docVersionId, lastDocVersionId: docVersionId, created: { atSim: "2026-10-14T10:30:00-03:00", by: "SYSTEM" } });
    const answer = unwrapDirect(await waiveObservationHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION, observationId, reason: "Aceptado" }));
    expect(answer).toMatchObject({ documentStatus: "WITH_OBSERVATION", approvalRequested: false });
    expect(world.approvals).toEqual([]);
  });

  it("a second waiver changes nothing; another operation's observation is NOT_FOUND", async () => {
    const world = await serviceWorld();
    const docVersionId = await fileVersion(world, "PACKING_LIST", "READ");
    const observationId = await openObservation(world, "PACKING_LIST", docVersionId);
    const waive = waiveObservationHandler(world.deps);
    unwrapDirect(await waive({ caller: consoleCaller(), operationId: OPERATION, observationId, reason: "Aceptado" }));
    expect(unwrapDirect(await waive({ caller: consoleCaller(), operationId: OPERATION, observationId, reason: "Aceptado" })).changed).toBe(false);
    expect(await waive({ caller: consoleCaller(), operationId: OPERATION, observationId: "obs-4471-CO-GROSS_WEIGHT_MISMATCH", reason: "x" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await waive({ caller: consoleCaller("firm-norte"), operationId: OPERATION, observationId, reason: "x" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});
