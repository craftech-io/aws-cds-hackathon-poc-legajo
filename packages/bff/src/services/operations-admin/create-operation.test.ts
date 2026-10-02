import { describe, expect, it } from "vitest";
import { MilestoneName, parseThreadAddress, verifyThreadTag } from "@legajo/shared";
import { hashOf } from "../../connector/testing";
import { milestoneDueTimes } from "../../milestones/schedule";
import { createOperationHandler } from "./create-operation";
import { unwrapDirect } from "./handler-kit";
import { CLOCK, FIRM, consoleCaller, platformRow, serviceWorld } from "./testing";

describe("create_operation [FL-005]", () => {
  it("[FL-005] copies the operation from the platform: OPEN dossier, three documents, its thread address claimed and five milestones", async () => {
    const world = await serviceWorld();
    world.platform.set(`${FIRM}#4479`, platformRow(FIRM, "4479", { documents: { COMMERCIAL_INVOICE: "RECEIVED", PACKING_LIST: "MISSING", CERTIFICATE_OF_ORIGIN: "MISSING" } }));
    const answer = unwrapDirect(await createOperationHandler(world.deps)({ caller: consoleCaller(FIRM, "ANALYST"), operationNumber: "4479" }));
    expect(answer).toMatchObject({ operationId: "op-4479", clockId: CLOCK, dossierStatus: "OPEN" });

    const { connector } = world.stores;
    const operation = await connector.operations.getOperation("op-4479");
    expect(operation).toMatchObject({ firmId: FIRM, importerId: "imp-norpampa", supplierId: "sup-qingdao", control: "AGENT", templateOperation: "op-4479", eta: "2026-10-30T08:00:00-03:00", portOfLoading: "Qingdao" });
    const parsed = parseThreadAddress(operation.threadAddress);
    expect(parsed?.operationNumber).toBe("4479");
    expect(await verifyThreadTag(world.deps.keys.threadKey(), { operationNumber: "4479", clockId: CLOCK, worldEpoch: 1 }, operation.threadTag)).toBe(true);
    expect((await connector.parties.getAddressClaim(hashOf(operation.threadAddress)))?.ownerId).toBe("op-4479");

    const documents = await connector.documents.listDocuments("op-4479");
    expect(Object.fromEntries(documents.map((document) => [document.docType, document.status]))).toEqual({ COMMERCIAL_INVOICE: "RECEIVED", PACKING_LIST: "MISSING", CERTIFICATE_OF_ORIGIN: "MISSING" });

    const timers = await connector.timers.listTimers("op-4479", { kind: "MILESTONE" });
    const due = milestoneDueTimes(operation.eta);
    expect(timers.map((timer) => timer.timerId).sort()).toEqual([...MilestoneName.options].sort());
    for (const timer of timers) {
      expect(timer.status).toBe("SCHEDULED");
      expect(Date.parse(timer.dueAtSim)).toBe(Date.parse(due[timer.timerId as MilestoneName]));
    }
    // A paused world gets no real schedules.
    expect(world.scheduler.schedules.size).toBe(0);
    const actions = (await connector.audit.listByOperation("op-4479")).map((row) => row.action);
    expect(actions).toContain("OPERATION_CREATED");
  });

  it("[FL-005] a milestone already past when the operation is created is dispatched once, never left scheduled", async () => {
    const world = await serviceWorld();
    world.platform.set(`${FIRM}#4480`, platformRow(FIRM, "4480", { eta: "2026-10-20T08:00:00-03:00" }));
    const answer = unwrapDirect(await createOperationHandler(world.deps)({ caller: consoleCaller(), operationNumber: "4480" }));
    expect(answer.milestones.dispatched).toEqual(["DOCS_REQUEST"]);
    expect(world.dispatched.map((due) => due.timer.timerId)).toEqual(["DOCS_REQUEST"]);
  });

  it("refuses an operation already in the console, a number the platform does not have and parties of another world", async () => {
    const world = await serviceWorld();
    const create = createOperationHandler(world.deps);
    expect(await create({ caller: consoleCaller(), operationNumber: "4471" })).toMatchObject({ ok: false, error: { code: "CONFLICT", reason: "OPERATION_EXISTS" } });
    expect(await create({ caller: consoleCaller(), operationNumber: "4490" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    world.platform.set("firm-norte#5590", platformRow("firm-norte", "5590"));
    expect(await create({ caller: consoleCaller("firm-norte"), operationNumber: "5590" })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "PARTIES_NOT_REGISTERED" } });
    expect(await world.stores.connector.operations.findOperation("op-5590")).toBeUndefined();
  });

  it("[FL-082] refuses the world of another firm", async () => {
    const world = await serviceWorld();
    world.platform.set(`${FIRM}#4479`, platformRow(FIRM, "4479"));
    const answer = await createOperationHandler(world.deps)({ caller: consoleCaller("firm-norte"), operationNumber: "4479", clockId: CLOCK });
    expect(answer).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "CROSS_FIRM" } });
  });
});
