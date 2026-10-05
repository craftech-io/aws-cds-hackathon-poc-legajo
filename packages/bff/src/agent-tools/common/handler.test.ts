import { describe, expect, it } from "vitest";
import { ToolError, fail, ok } from "@legajo/shared";
import { START_SIM } from "../../connector/testing";
import { createHandoffTarget } from "../handoff/index";
import { createMessagingTarget } from "../messaging/index";
import type { ToolResponse } from "./context";
import { gatewayContext } from "./principal";
import { OPERATION, type ToolWorld, auditRows, recording, toolWorld } from "./testing";

async function handoff(world: ToolWorld) {
  const approval = recording(() => ok({ dossierStatus: "READY_FOR_REVIEW" }));
  const escalation = recording();
  const target = createHandoffTarget(world.deps, { request_approval: approval.implementation, escalate_to_broker: escalation.implementation });
  return { target, approval, escalation };
}

function errorOf(response: ToolResponse): { code: string; reason?: string; message: string } {
  if (response.ok) throw new Error("expected a failure");
  return response.error;
}

describe("createToolHandler: the session is the only identity of a Harness call", () => {
  it("resolves the sessionToken, derives the scope from the stored session and writes the output to TURN#", async () => {
    const world = await toolWorld();
    const { target, approval } = await handoff(world);
    const turn = await world.openTurn("DOCUMENT_READ", { eventId: "evt_0123456789ABCDEFGHJKMNPQRS" });

    const response = await target.handle({ sessionToken: turn.token, summary: "All three documents are valid." }, gatewayContext("handoff___request_approval"));

    expect(response).toEqual({ ok: true, dossierStatus: "READY_FOR_REVIEW" });
    const ctx = approval.calls[0];
    expect(ctx?.input).toEqual({ summary: "All three documents are valid." });
    expect(ctx?.scope).toEqual({ operationId: OPERATION, operationNumber: "4471", firmId: "firm-delta", importerId: "imp-norpampa", supplierId: "sup-qingdao", clockId: "GLOBAL#firm-delta", nowSim: START_SIM });
    expect(ctx?.principal).toEqual({ kind: "SESSION", sessionId: turn.sessionId, turnId: turn.turnId, trigger: "DOCUMENT_READ", eventId: "evt_0123456789ABCDEFGHJKMNPQRS" });
    const results = await world.stores.connector.runtime.listTurnResults(turn.turnId);
    expect(results.map((result) => [result.tool, result.seq, result.output])).toEqual([["request_approval", 1, { ok: true, dossierStatus: "READY_FOR_REVIEW" }]]);
  });

  it("gives the implementation an audit writer bound to the call (actor AGENT, operation, turn, trigger, simulated instant)", async () => {
    const world = await toolWorld();
    const escalation = recording(async (ctx) => {
      await ctx.audit({ decision: "ACTION", action: "ESCALATED", reason: "IMPORTER_ASKED" });
      return ok({ escalationId: "esc-1" });
    });
    const target = createHandoffTarget(world.deps, { request_approval: recording().implementation, escalate_to_broker: escalation.implementation });
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    await target.handle({ sessionToken: turn.token, reason: "IMPORTER_ASKED", summary: "The importer asked for a person." }, gatewayContext("handoff___escalate_to_broker"));
    const [row] = await auditRows(world);
    expect(row).toMatchObject({ decision: "ACTION", action: "ESCALATED", actor: "AGENT", trigger: "IMPORTER_MESSAGE", clockId: "GLOBAL#firm-delta", operationId: OPERATION, atSim: START_SIM });
    expect(row?.refs).toEqual({ operationId: OPERATION, turnId: turn.turnId });
  });

  it("refuses a token of a closed turn and audits it in the session's firm; the implementation never runs", async () => {
    const world = await toolWorld();
    const { target, approval } = await handoff(world);
    const turn = await world.openTurn("DOCUMENT_READ");
    await world.closeTurn(turn.turnId);

    const response = await target.handle({ sessionToken: turn.token, summary: "Ready." }, gatewayContext("handoff___request_approval"));

    expect(errorOf(response)).toMatchObject({ code: "FORBIDDEN", reason: "SESSION_EXPIRED" });
    expect(approval.calls).toEqual([]);
    const rows = await auditRows(world);
    expect(rows.map((row) => [row.decision, row.action, row.reason, row.refs.turnId])).toEqual([["DENY", "REQUEST_APPROVAL", "TURN_CLOSED", turn.turnId]]);
    expect(await world.stores.connector.runtime.listTurnResults(turn.turnId)).toEqual([]);
  });

  it("refuses forged, expired and unknown tokens without writing anything to any firm's audit log", async () => {
    const world = await toolWorld();
    const { target, approval } = await handoff(world);
    const turn = await world.openTurn("DOCUMENT_READ");
    const [sessionId, turnId, exp, signature] = turn.token.split(".");
    const forged = `${sessionId}.${turnId}.${Number(exp) + 60}.${signature}`;
    const expired = `${sessionId}.${turnId}.${Number(exp) - 3600}.${signature}`;
    for (const token of [forged, expired, "not-a-token", `ses-nobody.${turnId}.${exp}.${signature}`]) {
      const response = await target.handle({ sessionToken: token, summary: "Ready." }, gatewayContext("handoff___request_approval"));
      expect(errorOf(response).code, token).toBe("FORBIDDEN");
    }
    expect(approval.calls).toEqual([]);
    expect(await auditRows(world)).toEqual([]);
    expect(world.logs.join("\n")).not.toContain(turn.token);
  });
});

describe("[FL-074] the agent cannot approve: zod refuses `decision` behind Cedar (LAM-STRICT)", () => {
  it("answers INVALID for request_approval with `decision`, whatever its value, audits LAM-STRICT and leaves the dossier alone", async () => {
    const world = await toolWorld();
    const { target, approval } = await handoff(world);
    const turn = await world.openTurn("DOCUMENT_READ");
    for (const decision of ["APPROVED", "approve", "", "READY_FOR_REVIEW", { status: "APPROVED" }, null]) {
      const response = await target.handle({ sessionToken: turn.token, summary: "All documents valid.", decision }, gatewayContext("handoff___request_approval"));
      expect(errorOf(response)).toMatchObject({ code: "INVALID", reason: "VALIDATION", message: "decision is never accepted (CED-NO-APPROVE)" });
    }
    expect(approval.calls).toEqual([]);
    const rows = await auditRows(world);
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row).toMatchObject({ decision: "DENY", action: "REQUEST_APPROVAL", ruleIds: ["LAM-STRICT"], actor: "AGENT", detail: { deniedFields: ["decision"] } });
    expect((await world.stores.connector.operations.getOperation(OPERATION)).dossierStatus).toBe("OPEN");
    expect(await world.stores.connector.runtime.listTurnResults(turn.turnId)).toEqual([]);
  });

  it("refuses `decision` from a direct caller too: no path of any principal carries a decision", async () => {
    const world = await toolWorld();
    const { target, approval } = await handoff(world);
    const response = await target.invoke("request_approval", { caller: { kind: "WORKER" }, operationId: OPERATION, summary: "Ready.", decision: "APPROVED" });
    expect(errorOf(response).code).toBe("INVALID");
    expect(approval.calls).toEqual([]);
  });
});

describe("LAM-STRICT: only what the schema declares, with the real values", () => {
  it("refuses an undeclared key, a value outside the real enum and text over its bound, naming only the fields", async () => {
    const world = await toolWorld();
    const { target, escalation } = await handoff(world);
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ reason: "OTHER", summary: "x", operationId: "op-4472" }, "operationId"],
      [{ reason: "OTHER", summary: "x", recipient: "someone@example.org" }, "recipient"],
      [{ reason: "MISSING_AT_ETA_48H", summary: "x" }, "reason"],
      [{ reason: "OTHER", summary: "y".repeat(501) }, "summary"],
    ];
    for (const [input, field] of cases) {
      const error = errorOf(await target.handle({ sessionToken: turn.token, ...input }, gatewayContext("handoff___escalate_to_broker")));
      expect(error).toMatchObject({ code: "INVALID", reason: "VALIDATION" });
      expect(error.message).toContain(field);
      expect(error.message).not.toContain("someone@example.org");
    }
    expect(escalation.calls).toEqual([]);
    expect((await auditRows(world)).every((row) => row.ruleIds.includes("LAM-STRICT"))).toBe(true);
  });

  it("lets a direct caller use the wider values its definition allows (every escalation reason for the worker)", async () => {
    const world = await toolWorld();
    const { target, escalation } = await handoff(world);
    const response = await target.invoke("escalate_to_broker", { caller: { kind: "WORKER", eventId: "evt_0123456789ABCDEFGHJKMNPQRS" }, operationId: OPERATION, reason: "MISSING_AT_ETA_48H", summary: "Missing at ETA − 48 h." });
    expect(response.ok).toBe(true);
    expect(escalation.calls[0]?.input).toEqual({ reason: "MISSING_AT_ETA_48H", summary: "Missing at ETA − 48 h." });
    expect(escalation.calls[0]?.principal).toEqual({ kind: "WORKER", caller: { kind: "WORKER", eventId: "evt_0123456789ABCDEFGHJKMNPQRS" } });
    expect(escalation.calls[0]?.scope.nowSim).toBe(new Date(START_SIM).toISOString());
  });
});

describe("LAM-TRIGGER: the trigger comes from the session, never from the input", () => {
  async function messaging(world: ToolWorld) {
    const whatsapp = recording(() => ok({ status: "SENT" }));
    const contact = recording(() => ok({ status: "PENDING_CONFIRMATION" }));
    const target = createMessagingTarget(world.deps, { send_whatsapp: whatsapp.implementation, send_email: recording().implementation, propose_supplier_contact: contact.implementation, route_to_operation: recording().implementation });
    return { target, whatsapp, contact };
  }
  const reminder = { recipientRole: "IMPORTER", kind: "REMINDER", template: { name: "legajo_recordatorio", params: ["Lucía", "4471"] } };

  it("sends a WhatsApp REMINDER only in MILESTONE or FOLLOWUP_DUE turns; elsewhere FORBIDDEN, audited, nothing sent", async () => {
    const world = await toolWorld();
    const { target, whatsapp } = await messaging(world);
    for (const trigger of ["MILESTONE", "FOLLOWUP_DUE"] as const) {
      const turn = await world.openTurn(trigger);
      expect((await target.handle({ sessionToken: turn.token, ...reminder }, gatewayContext("messaging___send_whatsapp"))).ok, trigger).toBe(true);
    }
    for (const trigger of ["UPLOAD_COMPLETED", "IMPORTER_MESSAGE", "DOCUMENT_READ"] as const) {
      const turn = await world.openTurn(trigger);
      const error = errorOf(await target.handle({ sessionToken: turn.token, ...reminder }, gatewayContext("messaging___send_whatsapp")));
      expect(error, trigger).toMatchObject({ code: "FORBIDDEN", reason: "TRIGGER_NOT_ALLOWED" });
    }
    expect(whatsapp.calls).toHaveLength(2);
    const denied = (await auditRows(world)).filter((row) => row.decision === "DENY");
    expect(denied.map((row) => [row.action, row.ruleIds, row.trigger])).toEqual([
      ["SEND_WHATSAPP", ["LAM-TRIGGER"], "UPLOAD_COMPLETED"],
      ["SEND_WHATSAPP", ["LAM-TRIGGER"], "IMPORTER_MESSAGE"],
      ["SEND_WHATSAPP", ["LAM-TRIGGER"], "DOCUMENT_READ"],
    ]);
  });

  it("lets a REPLY through in any turn (the rule is about reminders) and proposes a supplier contact only in IMPORTER_MESSAGE turns", async () => {
    const world = await toolWorld();
    const { target, whatsapp, contact } = await messaging(world);
    const upload = await world.openTurn("UPLOAD_COMPLETED");
    expect((await target.handle({ sessionToken: upload.token, recipientRole: "IMPORTER", kind: "REPLY", text: "Recibimos el certificado." }, gatewayContext("messaging___send_whatsapp"))).ok).toBe(true);
    expect(whatsapp.calls).toHaveLength(1);
    const proposal = { email: "ops@supplier.sim.legajo.demo.craftech.io", sourceMessageId: "msg-01J9ZQ" };
    const milestone = await world.openTurn("MILESTONE");
    expect(errorOf(await target.handle({ sessionToken: milestone.token, ...proposal }, gatewayContext("messaging___propose_supplier_contact"))).reason).toBe("TRIGGER_NOT_ALLOWED");
    expect(contact.calls).toEqual([]);
  });
});

describe("the envelope: a tool never throws", () => {
  it("turns what an implementation throws or returns wrong into {ok: false, error} and writes no TURN# row for it", async () => {
    const world = await toolWorld();
    const answers: Array<() => unknown> = [
      () => {
        throw new ToolError("NOT_COMPLETE", "the packing list is still missing");
      },
      () => {
        throw new Error("socket hang up at 10.0.0.1");
      },
      () => "not an envelope",
      () => fail("CONFLICT", "stale version"),
    ];
    const codes: string[] = [];
    for (const answer of answers) {
      const target = createHandoffTarget(world.deps, { request_approval: async () => answer() as ToolResponse, escalate_to_broker: recording().implementation });
      const turn = await world.openTurn("DOCUMENT_READ");
      const response = await target.handle({ sessionToken: turn.token, summary: "Ready." }, gatewayContext("handoff___request_approval"));
      codes.push(errorOf(response).code);
      expect(JSON.stringify(response)).not.toContain("10.0.0.1");
      expect(await world.stores.connector.runtime.listTurnResults(turn.turnId)).toEqual([]);
    }
    expect(codes).toEqual(["NOT_COMPLETE", "UNAVAILABLE", "UNAVAILABLE", "CONFLICT"]);
  });

  it("answers INVALID for an unknown tool, a non-object input or a direct event without {tool, input}", async () => {
    const world = await toolWorld();
    const { target } = await handoff(world);
    const turn = await world.openTurn("DOCUMENT_READ");
    expect(errorOf(await target.invoke("approve_dossier", { sessionToken: turn.token })).code).toBe("INVALID");
    expect(errorOf(await target.invoke("request_approval", ["not", "an", "object"])).code).toBe("INVALID");
    expect(errorOf(await target.handle({ sessionToken: turn.token, summary: "Ready." })).code).toBe("INVALID");
    const direct = await target.handle({ tool: "request_approval", input: { caller: { kind: "WORKER" }, operationId: OPERATION, summary: "Ready." } });
    expect(direct.ok).toBe(true);
  });

  it("refuses a Gateway call that names a tool of another target", async () => {
    const world = await toolWorld();
    const { target, approval } = await handoff(world);
    const turn = await world.openTurn("DOCUMENT_READ");
    const response = await target.handle({ sessionToken: turn.token, summary: "Ready." }, gatewayContext("operations___request_approval"));
    expect(errorOf(response).code).toBe("FORBIDDEN");
    expect(approval.calls).toEqual([]);
  });
});
