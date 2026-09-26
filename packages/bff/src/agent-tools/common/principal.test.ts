import { describe, expect, it } from "vitest";
import { ok } from "@legajo/shared";
import { createFollowupsTarget } from "../followups/index";
import { createHandoffTarget } from "../handoff/index";
import { createOperationsTarget } from "../operations/index";
import type { ToolResponse } from "./context";
import { gatewayContext, gatewayMarksOf } from "./principal";
import { FOREIGN_OPERATION, OPERATION, type ToolWorld, auditRows, recording, toolWorld } from "./testing";

const consoleCaller = { kind: "CONSOLE", firmId: "firm-delta", brokerId: "brk-delta-diego", role: "BROKER" } as const;

function errorOf(response: ToolResponse): { code: string; reason?: string } {
  if (response.ok) throw new Error("expected a failure");
  return response.error;
}

async function handoff(world: ToolWorld) {
  const approval = recording(() => ok({ dossierStatus: "READY_FOR_REVIEW" }));
  const escalation = recording(() => ok({ escalationId: "esc-1" }));
  return { target: createHandoffTarget(world.deps, { request_approval: approval.implementation, escalate_to_broker: escalation.implementation }), approval, escalation };
}

describe("gatewayMarksOf: the Gateway's marks in the Lambda client context", () => {
  it("reads the tool name and request id of a Gateway call, in either casing of `custom`", () => {
    expect(gatewayMarksOf(gatewayContext("handoff___request_approval", { requestId: "req-1" }))).toEqual({ present: true, toolName: "handoff___request_approval", requestId: "req-1" });
    expect(gatewayMarksOf({ clientContext: { Custom: { bedrockAgentCoreGatewayId: "gw-1" } } })).toEqual({ present: true });
  });

  it("finds none in a direct invocation", () => {
    expect(gatewayMarksOf(undefined)).toEqual({ present: false });
    expect(gatewayMarksOf({ awsRequestId: "r", clientContext: { custom: { somethingElse: 1 } } })).toEqual({ present: false });
  });
});

describe("LAM-CALLER: sessionToken XOR caller, and never a caller from the Gateway", () => {
  it("refuses a caller that comes through the Gateway, even with a valid operation, and runs nothing", async () => {
    const world = await toolWorld();
    const { target, approval } = await handoff(world);
    const response = await target.handle({ caller: { kind: "WORKER" }, operationId: OPERATION, summary: "Ready." }, gatewayContext("handoff___request_approval"));
    expect(errorOf(response)).toMatchObject({ code: "FORBIDDEN", reason: "CALLER_FROM_GATEWAY" });
    expect(approval.calls).toEqual([]);
  });

  it("refuses a caller next to a sessionToken on either path and audits it in the session's firm", async () => {
    const world = await toolWorld();
    const { target, approval } = await handoff(world);
    const turn = await world.openTurn("DOCUMENT_READ");
    const input = { sessionToken: turn.token, caller: { kind: "WORKER" }, summary: "Ready." };
    expect(errorOf(await target.handle(input, gatewayContext("handoff___request_approval")))).toMatchObject({ code: "FORBIDDEN", reason: "CALLER_WITH_TOKEN" });
    expect(errorOf(await target.invoke("request_approval", input))).toMatchObject({ code: "FORBIDDEN", reason: "CALLER_WITH_TOKEN" });
    expect(approval.calls).toEqual([]);
    const rows = await auditRows(world);
    expect(rows.map((row) => [row.decision, row.ruleIds, row.actor, row.refs.turnId])).toEqual([
      ["DENY", ["LAM-CALLER"], "AGENT", turn.turnId],
      ["DENY", ["LAM-CALLER"], "AGENT", turn.turnId],
    ]);
  });

  it("refuses a Gateway call without sessionToken and a direct call that names no principal", async () => {
    const world = await toolWorld();
    const { target } = await handoff(world);
    expect(errorOf(await target.handle({ summary: "Ready." }, gatewayContext("handoff___request_approval")))).toMatchObject({ code: "FORBIDDEN", reason: "SESSION_INVALID" });
    expect(errorOf(await target.invoke("request_approval", { summary: "Ready." }))).toMatchObject({ code: "FORBIDDEN", reason: "NO_PRINCIPAL" });
    expect(errorOf(await target.invoke("request_approval", { caller: { kind: "CONSOLE" }, operationId: OPERATION, summary: "Ready." }))).toMatchObject({ code: "INVALID", reason: "CALLER_INVALID" });
    expect(errorOf(await target.invoke("request_approval", { caller: { kind: "WORKER" }, summary: "Ready." }))).toMatchObject({ code: "INVALID", reason: "CALLER_INVALID" });
  });

  it("admits only the callers docs/tool-catalog.md lists for the tool, auditing the refusal with the caller as actor", async () => {
    const world = await toolWorld();
    const { target, escalation } = await handoff(world);
    const response = await target.invoke("escalate_to_broker", { caller: consoleCaller, operationId: OPERATION, reason: "OTHER", summary: "Console escalation." });
    expect(errorOf(response)).toMatchObject({ code: "FORBIDDEN", reason: "ROLE_NOT_ALLOWED" });
    expect(escalation.calls).toEqual([]);
    const [row] = await auditRows(world);
    expect(row).toMatchObject({ decision: "DENY", action: "ESCALATE_TO_BROKER", ruleIds: ["LAM-CALLER"], actor: "BROKER:brk-delta-diego", operationId: OPERATION });

    const followup = recording();
    const followups = createFollowupsTarget(world.deps, { schedule_followup: followup.implementation, estimate_delay_risk: recording().implementation });
    const worker = await followups.invoke("schedule_followup", { caller: { kind: "WORKER" }, operationId: OPERATION, party: "SUPPLIER", atSim: "2026-10-16T10:00:00-03:00", reason: "OTHER" });
    expect(errorOf(worker).reason).toBe("ROLE_NOT_ALLOWED");
    expect(followup.calls).toEqual([]);
  });

  it("lets the console and the QaDriver read their own firm's operation, with the world's simulated now", async () => {
    const world = await toolWorld();
    const read = recording((ctx) => ok({ operationNumber: ctx.scope.operationNumber }));
    const tools = recording().implementation;
    const operations = createOperationsTarget(world.deps, { get_operation: read.implementation, get_dossier: tools, assign_responsible: tools, get_counterpart_profile: tools, get_checklist: tools, get_dispatch_status: tools });
    expect(await operations.invoke("get_operation", { caller: consoleCaller, operationId: OPERATION })).toEqual({ ok: true, operationNumber: "4471" });
    const qa = { kind: "QA", firmId: "firm-delta", brokerId: "brk-qa-runner", role: "BROKER" } as const;
    expect((await operations.invoke("get_operation", { caller: qa, operationId: OPERATION })).ok).toBe(true);
    expect(read.calls.map((ctx) => ctx.principal.kind)).toEqual(["CONSOLE", "QA"]);
  });
});

describe("LAM-OP-SCOPE for direct callers: the console only reaches its own firm", () => {
  it("refuses another firm's operation, records it in the caller's firm and leaves the other firm's trail untouched", async () => {
    const world = await toolWorld();
    const read = recording();
    const tools = recording().implementation;
    const operations = createOperationsTarget(world.deps, { get_operation: read.implementation, get_dossier: tools, assign_responsible: tools, get_counterpart_profile: tools, get_checklist: tools, get_dispatch_status: tools });
    const response = await operations.invoke("get_operation", { caller: consoleCaller, operationId: FOREIGN_OPERATION });
    expect(errorOf(response)).toMatchObject({ code: "FORBIDDEN", reason: "CROSS_FIRM" });
    expect(read.calls).toEqual([]);
    const [row] = await auditRows(world);
    expect(row).toMatchObject({ firmId: "firm-delta", decision: "DENY", ruleIds: ["LAM-OP-SCOPE"], reason: "CROSS_FIRM", detail: { targetKind: "operation", targetId: FOREIGN_OPERATION } });
    expect(row?.operationId).toBeUndefined();
    expect(await world.stores.connector.audit.listByOperation(FOREIGN_OPERATION)).toEqual([]);
    expect(await auditRows(world, "firm-norte")).toEqual([]);
  });

  it("answers NOT_FOUND for an operation that does not exist", async () => {
    const world = await toolWorld();
    const { target } = await handoff(world);
    expect(errorOf(await target.invoke("request_approval", { caller: { kind: "WORKER" }, operationId: "op-4499", summary: "Ready." })).code).toBe("NOT_FOUND");
  });
});
