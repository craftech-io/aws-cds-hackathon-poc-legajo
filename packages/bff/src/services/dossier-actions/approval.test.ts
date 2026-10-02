import { describe, expect, it } from "vitest";
import { scheduleMilestones } from "../../milestones/schedule";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { FIRM, OPERATION, type ServiceWorld, consoleCaller, readyForReview, serviceWorld, setDocuments } from "../operations-admin/testing";
import { approveDossierHandler, keptAfterApproval, reopenDossierHandler } from "./approval";

async function withMilestones(world: ServiceWorld): Promise<void> {
  const operation = await world.stores.connector.operations.getOperation(OPERATION);
  await scheduleMilestones({ operation }, world.deps.timers);
}

describe("approve_dossier [FL-073] [FL-075]", () => {
  it("[FL-073] approves a complete dossier ready for review: approvedBy, legajo_aprobado queued, reminders cancelled except ARRIVAL", async () => {
    const world = await serviceWorld();
    await withMilestones(world);
    await readyForReview(world);
    const answer = unwrapDirect(await approveDossierHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION }));
    expect(answer).toMatchObject({ dossierStatus: "APPROVED", approvedBy: "brk-delta-diego" });

    const operation = await world.stores.connector.operations.getOperation(OPERATION);
    expect(operation).toMatchObject({ dossierStatus: "APPROVED", approvedBy: "brk-delta-diego" });
    expect(operation.dossierHistory.map((entry) => entry.status)).toEqual(["OPEN", "READY_FOR_REVIEW", "APPROVED"]);

    expect(world.events).toMatchObject([{ type: "OUTBOUND_SEND", kind: "APPROVAL_NOTICE", author: "BROKER:brk-delta-diego", channel: "WHATSAPP", template: { name: "legajo_aprobado", params: ["4471"] } }]);
    const timers = await world.stores.connector.timers.listTimers(OPERATION, { kind: "MILESTONE" });
    expect(timers.filter((timer) => timer.status === "SCHEDULED").map((timer) => timer.timerId)).toEqual(["ARRIVAL"]);
    expect(timers.filter((timer) => timer.status === "CANCELLED")).toHaveLength(4);

    const approved = (await world.stores.connector.audit.listByOperation(OPERATION)).find((row) => row.action === "APPROVED");
    expect(approved?.refs).toMatchObject({ brokerId: "brk-delta-diego" });
    const kpi = await world.stores.connector.metrics.getKpi({ firmId: FIRM, source: "WORLD", clockId: operation.clockId, operationId: OPERATION });
    expect(kpi).toMatchObject({ humanActions: 1, humanMinutes: 10, dossierStatus: "APPROVED" });
  });

  it("[FL-075] an analyst gets 403 and DENY ROLE_NOT_ALLOWED; nothing changes", async () => {
    const world = await serviceWorld();
    await readyForReview(world);
    const answer = await approveDossierHandler(world.deps)({ caller: consoleCaller(FIRM, "ANALYST"), operationId: OPERATION });
    expect(answer).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "ROLE_NOT_ALLOWED" } });
    const denies = await world.stores.connector.audit.listByDecision(FIRM, "DENY");
    expect(denies).toMatchObject([{ action: "ROLE_NOT_ALLOWED", ruleIds: ["LAM-CALLER"], refs: { brokerId: "brk-delta-martina" } }]);
    expect((await world.stores.connector.operations.getOperation(OPERATION)).dossierStatus).toBe("READY_FOR_REVIEW");
    expect(world.events).toEqual([]);
  });

  it("refuses a dossier that is not ready for review or not complete, and another firm's", async () => {
    const world = await serviceWorld();
    const approve = approveDossierHandler(world.deps);
    expect(await approve({ caller: consoleCaller(), operationId: OPERATION })).toMatchObject({ ok: false, error: { code: "CONFLICT", reason: "NOT_READY_FOR_REVIEW" } });
    await readyForReview(world);
    await setDocuments(world, { PACKING_LIST: "WITH_OBSERVATION" });
    expect(await approve({ caller: consoleCaller(), operationId: OPERATION })).toMatchObject({ ok: false, error: { code: "NOT_COMPLETE" } });
    expect(await approve({ caller: consoleCaller("firm-norte"), operationId: OPERATION })).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "CROSS_FIRM" } });
  });

  it("an approval keeps the arrival milestone and every timer that is not a reminder", () => {
    expect(keptAfterApproval({ kind: "MILESTONE", timerId: "ARRIVAL" })).toBe(true);
    expect(keptAfterApproval({ kind: "MILESTONE", timerId: "FOLLOWUP" })).toBe(false);
    expect(keptAfterApproval({ kind: "FOLLOWUP_DUE", timerId: "fu-1" })).toBe(false);
    expect(keptAfterApproval({ kind: "DEFERRED_SEND", timerId: "msg-1" })).toBe(true);
  });
});

describe("reopen_dossier [FL-076]", () => {
  it("[FL-076] reopens an approved dossier with its reason for a new approval cycle", async () => {
    const world = await serviceWorld();
    await readyForReview(world);
    unwrapDirect(await approveDossierHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION }));
    const answer = unwrapDirect(await reopenDossierHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION, reason: "Llegó un certificado de origen nuevo" }));
    expect(answer).toMatchObject({ dossierStatus: "REOPENED" });
    const operation = await world.stores.connector.operations.getOperation(OPERATION);
    expect(operation.dossierHistory.at(-1)).toMatchObject({ status: "REOPENED", reason: "Llegó un certificado de origen nuevo", by: "BROKER:brk-delta-diego" });
    const actions = (await world.stores.connector.audit.listByOperation(OPERATION)).map((row) => row.action);
    expect(actions).toContain("REOPENED");
    expect(await reopenDossierHandler(world.deps)({ caller: consoleCaller(), operationId: OPERATION, reason: "otra vez" })).toMatchObject({ ok: false, error: { code: "CONFLICT", reason: "NOT_APPROVED" } });
  });
});
