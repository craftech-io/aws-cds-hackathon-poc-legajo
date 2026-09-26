import { describe, expect, it } from "vitest";
import { GATEWAY_TOOLS, type GatewayToolName, ToolTarget, gatewayActionName } from "@legajo/shared";
import { CLOCK, FIRM, REAL_NOW } from "../../connector/testing";
import { createGatewayTargets, gatewayTargetsPort } from "./targets";
import { OPERATION, toolWorld } from "./testing";

/** The smallest input each tool accepts from the Gateway, besides `sessionToken`. */
const MINIMAL_INPUT: { readonly [T in GatewayToolName]: Readonly<Record<string, unknown>> } = {
  get_operation: {},
  get_dossier: {},
  assign_responsible: { observationId: "obs-4471-PL-GROSS_WEIGHT_MISMATCH", responsibleParty: "SUPPLIER", rationale: "The supplier issued the packing list." },
  get_counterpart_profile: { party: "SUPPLIER" },
  get_checklist: { docType: "PACKING_LIST" },
  get_dispatch_status: {},
  read_document: { docVersionId: "dv-4471-PL-1" },
  create_upload_link: { docTypes: ["CERTIFICATE_OF_ORIGIN"] },
  send_whatsapp: { recipientRole: "IMPORTER", kind: "REPLY", text: "Recibimos el packing list." },
  send_email: { recipientRole: "SUPPLIER", kind: "DOCS_REQUEST", text: "Please send the packing list of invoice QBT-2026-0917.", refs: { docTypes: ["PACKING_LIST"] } },
  propose_supplier_contact: { email: "ops@supplier.sim.legajo.demo.craftech.io", sourceMessageId: "msg-01J9ZQIN" },
  schedule_followup: { party: "SUPPLIER", atSim: "2026-10-16T10:00:00-03:00", reason: "PROMISED_BY_SUPPLIER" },
  estimate_delay_risk: {},
  escalate_to_broker: { reason: "IMPORTER_ASKED", summary: "The importer asked to talk to a person." },
  request_approval: { summary: "All three documents are valid." },
};

describe("the five targets as the Gateway reaches them (wave 2: every tool answers UNAVAILABLE behind the wrapper)", () => {
  it("routes each of the 15 Gateway actions to its target and answers UNAVAILABLE after every guard passed", async () => {
    const world = await toolWorld();
    // The importer's message that holds the proposed address (LAM-OP-SCOPE reads it).
    await world.stores.connector.conversations.appendMessage({
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
      body: "Los manda el proveedor: ops@supplier.sim.legajo.demo.craftech.io",
      sentAtSim: "2026-10-14T10:30:00-03:00",
      sentAtReal: REAL_NOW,
    });
    const port = gatewayTargetsPort(createGatewayTargets(world.deps));
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    for (const target of ToolTarget.options) {
      for (const tool of GATEWAY_TOOLS[target]) {
        const response = await port.invoke({ target, action: gatewayActionName(tool), input: { sessionToken: turn.token, ...MINIMAL_INPUT[tool] } });
        expect(response, tool).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      }
    }
    const pending = world.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["message"] === "tool.not_implemented");
    expect(pending.map((line) => [line["tool"], line["owner"]])).toEqual([
      ["get_operation", "WP-26"],
      ["get_dossier", "WP-26"],
      ["assign_responsible", "WP-26"],
      ["get_counterpart_profile", "WP-26"],
      ["get_checklist", "WP-26"],
      ["get_dispatch_status", "WP-26"],
      ["read_document", "WP-26"],
      ["create_upload_link", "WP-26"],
      ["send_whatsapp", "WP-25"],
      ["send_email", "WP-25"],
      ["propose_supplier_contact", "WP-25"],
      ["schedule_followup", "WP-27"],
      ["estimate_delay_risk", "WP-27"],
      ["escalate_to_broker", "WP-27"],
      ["request_approval", "WP-27"],
    ]);
    // Failures are not facts: nothing grounds a message yet.
    expect(await world.stores.connector.runtime.listTurnResults(turn.turnId)).toEqual([]);
  });

  it("keeps every guard on the placeholders: a field Cedar forbids is still refused, and nothing runs without a session", async () => {
    const world = await toolWorld();
    const port = gatewayTargetsPort(createGatewayTargets(world.deps));
    const turn = await world.openTurn("DOCUMENT_READ");
    const approve = await port.invoke({ target: "handoff", action: "handoff___request_approval", input: { sessionToken: turn.token, summary: "Ready.", decision: "APPROVED" } });
    expect(approve).toMatchObject({ ok: false, error: { code: "INVALID" } });
    const noSession = await port.invoke({ target: "operations", action: "operations___get_dossier", input: {} });
    expect(noSession).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(world.logs.some((line) => line.includes("tool.not_implemented"))).toBe(false);
  });
});
