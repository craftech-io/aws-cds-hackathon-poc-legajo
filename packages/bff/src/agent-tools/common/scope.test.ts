import { describe, expect, it } from "vitest";
import { ID_SPEC, ok } from "@legajo/shared";
import { createMessagingTarget } from "../messaging/index";
import { createOperationsTarget } from "../operations/index";
import { allDefinitions } from "./catalog";
import type { ToolResponse } from "./context";
import { jsonSchemaOf } from "./gateway-schema";
import { gatewayContext } from "./principal";
import { SCOPE_WALK_LIMITS, type ScopeLookups, type ToolScope, connectorLookups, embedsOperation, scopeViolation, scopedRefsOf } from "./scope";
import { type ToolWorld, auditRows, recording, toolWorld } from "./testing";

const scope: ToolScope = {
  operationId: "op-4471",
  operationNumber: "4471",
  firmId: "firm-delta",
  importerId: "imp-norpampa",
  supplierId: "sup-qingdao",
  clockId: "GLOBAL#firm-delta",
  nowSim: "2026-10-14T10:30:00-03:00",
};

const lookups: ScopeLookups = {
  isContactOfSupplier: async (supplierId, contactId) => supplierId === "sup-qingdao" && contactId === "ctc-qingdao-1",
  isMessageOfOperation: async (operationId, messageId) => operationId === "op-4471" && messageId === "msg-01J9ZQIN",
};

function errorOf(response: ToolResponse): { code: string; reason?: string; message: string } {
  if (response.ok) throw new Error("expected a failure");
  return response.error;
}

describe("scopedRefsOf: every value that names something of an operation, whatever the field", () => {
  it("classifies ids by prefix, nested in objects and arrays, and `operationNumber` fields by name", () => {
    const walk = scopedRefsOf({ observationId: "obs-4471-PL-GROSS_WEIGHT_MISMATCH", refs: { observationIds: ["obs-4471-CI-MISSING_SIGNATURE"], docTypes: ["PACKING_LIST"] }, buttons: [{ action: "UPLOAD", operationNumber: "4471" }], text: "Falta el packing list de la 4471" });
    expect(walk).toEqual({
      ok: true,
      refs: [
        { kind: "observation", value: "obs-4471-PL-GROSS_WEIGHT_MISMATCH", path: "observationId" },
        { kind: "observation", value: "obs-4471-CI-MISSING_SIGNATURE", path: "refs.observationIds.0" },
        { kind: "operationNumber", value: "4471", path: "buttons.0.operationNumber" },
      ],
    });
  });

  it("fails closed past its bounds instead of checking part of the input", () => {
    let deep: unknown = "op-4471";
    for (let level = 0; level <= SCOPE_WALK_LIMITS.depth; level += 1) deep = { next: deep };
    expect(scopedRefsOf(deep)).toEqual({ ok: false, limit: "depth" });
    expect(scopedRefsOf({ ids: Array.from({ length: SCOPE_WALK_LIMITS.refs + 1 }, () => "op-4471") })).toEqual({ ok: false, limit: "refs" });
  });
});

describe("scopeViolation (LAM-OP-SCOPE)", () => {
  it("accepts the ids of the scope's own operation, parties, firm, contact and message", async () => {
    const own = ["op-4471", "dv-4471-PL-1", "obs-4471-PL-GROSS_WEIGHT_MISMATCH", "imp-norpampa", "sup-qingdao", "firm-delta", "ctc-qingdao-1", "msg-01J9ZQIN"];
    expect(await scopeViolation(scope, { own, operationNumber: "4471" }, lookups)).toBeUndefined();
  });

  it.each([
    ["op-4472", "is another operation"],
    ["dv-4472-PL-1", "belongs to another operation"],
    ["obs-4472-PL-GROSS_WEIGHT_MISMATCH", "belongs to another operation"],
    ["dv-4471-j03-PL-1", "belongs to another operation"],
    ["imp-other", "is not the importer of this operation"],
    ["sup-other", "is not the supplier of this operation"],
    ["firm-norte", "belongs to another firm"],
    ["ctc-other-1", "is not a contact of the supplier of this operation"],
    ["msg-01J9ZQOTHER", "is not a message of this operation"],
    ["brk-delta-diego", "no Gateway tool takes a broker id"],
  ])("refuses %s", async (value, why) => {
    expect(await scopeViolation(scope, { refs: { any: [value] } }, lookups)).toEqual({ reason: "OUT_OF_SCOPE", ref: expect.objectContaining({ value, path: "refs.any.0" }), why });
  });

  it("tells a model operation from its clone in another world (`4471` vs `4471-j03`)", () => {
    expect(embedsOperation("dv-4471-PL-1", "docVersion", "op-4471")).toBe(true);
    expect(embedsOperation("dv-4471-j03-PL-1", "docVersion", "op-4471")).toBe(false);
    expect(embedsOperation("dv-4471-PL-1", "docVersion", "op-4471-j03")).toBe(false);
    expect(embedsOperation("obs-4471-j03-CO-ORIGIN_MISMATCH", "observation", "op-4471-j03")).toBe(true);
  });

  it("refuses another operation number and an input past the walk's bounds", async () => {
    expect(await scopeViolation(scope, { buttons: [{ operationNumber: "4472" }] }, lookups)).toMatchObject({ reason: "OUT_OF_SCOPE", why: "is another operation number" });
    expect(await scopeViolation(scope, { ids: Array.from({ length: 41 }, () => "op-4471") }, lookups)).toEqual({ reason: "INPUT_TOO_LARGE", limit: "refs" });
  });

  it("reads contacts and messages through the connector", async () => {
    const world = await toolWorld();
    const real = connectorLookups(world.stores.connector);
    expect(await real.isContactOfSupplier("sup-qingdao", "ctc-qingdao-1")).toBe(true);
    expect(await real.isContactOfSupplier("sup-other", "ctc-qingdao-1")).toBe(false);
    expect(await real.isMessageOfOperation("op-4471", "msg-01J9ZQIN")).toBe(false);
  });
});

describe("every id a tool schema accepts is one the scope walk classifies", () => {
  const prefixes = Object.values(ID_SPEC).map((spec) => spec.prefix);
  type JsonNode = { readonly properties?: Record<string, JsonNode>; readonly items?: JsonNode; readonly pattern?: string };

  function idFields(node: JsonNode, path: string, out: Array<{ path: string; node: JsonNode }>): void {
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      if (/Ids?$/.test(name)) out.push({ path: `${path}.${name}`, node: child.items ?? child });
      idFields(child.items ?? child, `${path}.${name}`, out);
    }
  }

  it("pins every *Id / *Ids field to an id pattern with a known prefix", () => {
    const fields: Array<{ path: string; node: JsonNode }> = [];
    for (const { definition } of allDefinitions()) idFields(jsonSchemaOf(definition) as JsonNode, definition.name, fields);
    expect(fields.length).toBeGreaterThan(0);
    for (const { path, node } of fields) {
      expect(node.pattern, path).toBeDefined();
      expect(prefixes.some((prefix) => node.pattern?.startsWith(`^${prefix}-`)), path).toBe(true);
    }
  });
});

describe("LAM-OP-SCOPE through createToolHandler", () => {
  async function targets(world: ToolWorld) {
    const assign = recording(() => ok({ matchesMatrix: true }));
    const email = recording(() => ok({ status: "SENT" }));
    const whatsapp = recording(() => ok({ status: "SENT" }));
    const contact = recording(() => ok({ status: "PENDING_CONFIRMATION" }));
    const any = recording().implementation;
    const operations = createOperationsTarget(world.deps, { assign_responsible: assign.implementation, get_operation: any, get_dossier: any, get_counterpart_profile: any, get_checklist: any, get_dispatch_status: any });
    const messaging = createMessagingTarget(world.deps, { send_email: email.implementation, send_whatsapp: whatsapp.implementation, propose_supplier_contact: contact.implementation, route_to_operation: any });
    return { operations, messaging, assign, email, whatsapp, contact };
  }

  it("refuses an observation of another operation (FORBIDDEN, audited DENY LAM-OP-SCOPE) and runs the own one", async () => {
    const world = await toolWorld();
    const { operations, assign } = await targets(world);
    const turn = await world.openTurn("DOCUMENT_READ");
    const input = { sessionToken: turn.token, responsibleParty: "SUPPLIER", rationale: "The supplier issued the packing list." };
    const foreign = await operations.handle({ ...input, observationId: "obs-4472-PL-GROSS_WEIGHT_MISMATCH" }, gatewayContext("operations___assign_responsible"));
    expect(errorOf(foreign)).toMatchObject({ code: "FORBIDDEN", reason: "OPERATION_NOT_IN_SESSION", message: "observationId belongs to another operation" });
    expect(assign.calls).toEqual([]);
    const own = await operations.handle({ ...input, observationId: "obs-4471-PL-GROSS_WEIGHT_MISMATCH" }, gatewayContext("operations___assign_responsible"));
    expect(own.ok).toBe(true);
    const [row] = await auditRows(world);
    expect(row).toMatchObject({ decision: "DENY", action: "ASSIGN_RESPONSIBLE", ruleIds: ["LAM-OP-SCOPE"], detail: { path: "observationId", kind: "observation", targetId: "obs-4472-PL-GROSS_WEIGHT_MISMATCH" } });
  });

  it("refuses a contact of another supplier, a foreign observation in refs, another operation's button and a message not of this operation", async () => {
    const world = await toolWorld();
    const { messaging, email, whatsapp, contact } = await targets(world);
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    const send = (tool: string, input: Record<string, unknown>) => messaging.handle({ sessionToken: turn.token, ...input }, gatewayContext(`messaging___${tool}`));
    const mail = { recipientRole: "SUPPLIER", kind: "CORRECTION_REQUEST", text: "Please correct the gross weight of invoice QBT-2026-0917.", refs: { docTypes: ["PACKING_LIST"] } };
    expect(errorOf(await send("send_email", { ...mail, contactId: "ctc-other-1" })).reason).toBe("OPERATION_NOT_IN_SESSION");
    expect((await send("send_email", { ...mail, contactId: "ctc-qingdao-1" })).ok).toBe(true);
    const reply = { recipientRole: "IMPORTER", kind: "REPLY", text: "Recibimos tu mensaje." };
    expect(errorOf(await send("send_whatsapp", { ...reply, refs: { observationIds: ["obs-4471-PL-GROSS_WEIGHT_MISMATCH", "obs-4472-CI-MISSING_STAMP"] } })).message).toBe("refs.observationIds.1 belongs to another operation");
    expect(errorOf(await send("send_whatsapp", { ...reply, buttons: [{ action: "UPLOAD", operationNumber: "4472" }] })).message).toBe("buttons.0.operationNumber is another operation number");
    expect(errorOf(await send("propose_supplier_contact", { email: "ops@supplier.sim.legajo.demo.craftech.io", sourceMessageId: "msg-01J9ZQOTHER" })).reason).toBe("OPERATION_NOT_IN_SESSION");
    expect([email.calls.length, whatsapp.calls.length, contact.calls.length]).toEqual([1, 0, 0]);
  });
});
