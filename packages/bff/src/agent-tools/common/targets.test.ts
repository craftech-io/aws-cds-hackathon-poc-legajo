import { describe, expect, it } from "vitest";
import { GATEWAY_TOOLS, type GatewayToolName, ToolError, ToolTarget, gatewayActionName } from "@legajo/shared";
import { CLOCK, FIRM, REAL_NOW } from "../../connector/testing";
import { gatewayContext } from "./principal";
import { type GatewayTargetPorts, createGatewayTargets, gatewayTargetsPort } from "./targets";
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
  route_to_operation: { toOperationNumber: "4478" },
  schedule_followup: { party: "SUPPLIER", atSim: "2026-10-16T10:00:00-03:00", reason: "PROMISED_BY_SUPPLIER" },
  estimate_delay_risk: {},
  escalate_to_broker: { reason: "IMPORTER_ASKED", summary: "The importer asked to talk to a person." },
  request_approval: { summary: "All three documents are valid." },
};

/** Ports that never leave the test: a send, a schedule or a reading answers UNAVAILABLE. */
const offline = (what: string) => () => {
  throw new ToolError("UNAVAILABLE", `${what} is not part of this test`);
};
const OFFLINE_PORTS: GatewayTargetPorts = {
  messaging: { outbound: offline("the outbound pipeline") },
  handoff: { send: offline("the outbound pipeline"), agentMode: "SCRIPTED" },
  followups: { scheduler: { put: offline("a schedule"), delete: offline("a schedule") }, dispatcher: { dispatch: offline("a timer") } },
  documents: { reader: offline("the reader"), sourceUrl: offline("a source URL"), newToken: () => "test-token-0123456789abcdefghijklmnopqrstuv" },
};

describe("the five targets as the Gateway reaches them", () => {
  it("routes each of the 16 Gateway actions to its own tool behind every guard", async () => {
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
    const port = gatewayTargetsPort(createGatewayTargets(world.deps, OFFLINE_PORTS));
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    const reached: string[] = [];
    for (const target of ToolTarget.options) {
      for (const tool of GATEWAY_TOOLS[target]) {
        const before = world.logs.length;
        const response = await port.invoke({ target, action: gatewayActionName(tool), input: { sessionToken: turn.token, ...MINIMAL_INPUT[tool] } });
        expect(response, tool).not.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        const calls = world.logs.slice(before).map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["message"] === "tool.call");
        expect(calls.map((line) => line["tool"]), tool).toEqual([tool]);
        reached.push(tool);
      }
    }
    expect(reached).toHaveLength(16);
  });

  it("refuses an action the Gateway names outside the target that receives it", async () => {
    const world = await toolWorld();
    const targets = createGatewayTargets(world.deps, OFFLINE_PORTS);
    const turn = await world.openTurn("IMPORTER_MESSAGE");
    const misrouted = await targets.handoff.handle({ sessionToken: turn.token }, gatewayContext("operations___get_operation"));
    expect(misrouted).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("keeps every guard: a field Cedar forbids is still refused, and nothing runs without a session", async () => {
    const world = await toolWorld();
    const port = gatewayTargetsPort(createGatewayTargets(world.deps, OFFLINE_PORTS));
    const turn = await world.openTurn("DOCUMENT_READ");
    const approve = await port.invoke({ target: "handoff", action: "handoff___request_approval", input: { sessionToken: turn.token, summary: "Ready.", decision: "APPROVED" } });
    expect(approve).toMatchObject({ ok: false, error: { code: "INVALID" } });
    const noSession = await port.invoke({ target: "operations", action: "operations___get_dossier", input: {} });
    expect(noSession).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});
