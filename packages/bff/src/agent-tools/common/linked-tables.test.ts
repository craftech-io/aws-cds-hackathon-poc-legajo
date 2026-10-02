// The tables each Gateway target Lambda links (infra/iam-capabilities.ts) against the tables its code
// reaches. In the stage, lib/resource.ts reads `Resource.<Table>` through SST's Proxy, which throws when
// the table is not linked; the in-memory connector has no links, so every tool test passes either way.
// Here each target runs its tools over the in-memory client restricted to `expectedTables(fn)`
// (`MemoryTableClient.linkOnly`), and any access outside them fails the case, even one the code catches
// (the 24-hour window of `get_counterpart_profile` swallows its error). No AWS account.
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Reading } from "@legajo/reader-contract";
import { describe, expect, it } from "vitest";
import { ToolTarget } from "@legajo/shared";
import { gatewayContext } from "./principal";
import { OPERATION, TEST_SESSION_KEY, toolWorld } from "./testing";
import type { GatewayTargetRuntime, ToolDeps } from "./handler";
import { documentsImplementations } from "../documents/handler";
import { createDocumentsTarget } from "../documents/index";
import { followupsWorld } from "../followups/testing";
import { handoffImplementations } from "../handoff/handler";
import { createHandoffTarget } from "../handoff/index";
import { DOSSIER, messagingWorld, type MessagingWorld } from "../messaging/testing";
import { createOperationsTarget } from "../operations/index";
import { createTestObservation, fileTestVersion, seedFirm } from "../operations/testing";
import { REAL_NOW } from "../../connector/testing";
import type { MemoryTableClient } from "../../connector/memory/table-client";
import { TABLE_NAMES, type TableName } from "../../lib/resource";
import { createLogger } from "../../lib/log";
import { seedSettings } from "../../milestones/testing";
import { sendOutbound } from "../../outbound/pipeline";
import { FRI_10_QINGDAO, THU_10_AR } from "../../outbound/testing";
import { TOOL_FUNCTIONS } from "../../../../../infra/agentcore-spec";
import { expectedTables, type LambdaName } from "../../../../../infra/iam-capabilities";

/** The DynamoDB tables `fn` links, as the connector names them. */
function linkedTables(fn: LambdaName, without: readonly TableName[] = []): TableName[] {
  return TABLE_NAMES.filter((table) => table in expectedTables(fn) && !without.includes(table));
}

/** Runs `body` as the Lambda `fn` would: only its linked tables answer. Returns every other table touched. */
async function asLinked(client: MemoryTableClient, fn: LambdaName, body: () => Promise<void>, without: readonly TableName[] = []): Promise<TableName[]> {
  const before = client.unlinkedAccesses.length;
  client.linkOnly(linkedTables(fn, without));
  try {
    await body();
  } finally {
    client.linkOnly(undefined);
  }
  return [...new Set(client.unlinkedAccesses.slice(before))].sort();
}

const okAnswer = { ok: true };

async function operationsScenario(without: readonly TableName[] = []): Promise<{ readonly unlinked: TableName[]; readonly window: unknown }> {
  const world = await toolWorld();
  await seedFirm(world.stores);
  const version = await fileTestVersion(world.stores, { docType: "PACKING_LIST", party: "SUPPLIER" });
  const observation = await createTestObservation(world.stores, { docType: "PACKING_LIST", code: "GROSS_WEIGHT_MISMATCH", docVersionId: version.docVersionId });
  await world.stores.connector.conversations.appendMessage({ messageId: "msg-in00000001", operationId: OPERATION, firmId: "firm-delta", clockId: "GLOBAL#firm-delta", direction: "IN", channel: "WHATSAPP", counterpart: "IMPORTER", importerId: "imp-norpampa", to: "simulated", from: "+5491155500101", body: "Hola", status: "RECEIVED", author: "IMPORTER", trusted: true, simulated: true, sentAtSim: "2026-10-14T09:00:00-03:00", sentAtReal: REAL_NOW });
  const { token } = await world.openTurn("DOCUMENT_READ");
  const target = createOperationsTarget(world.deps);
  const call = (tool: string, input: Record<string, unknown> = {}) => target.handle({ sessionToken: token, ...input }, gatewayContext(`operations___${tool}`));
  let window: unknown;
  const unlinked = await asLinked(
    world.stores.client,
    "ToolOperations",
    async () => {
      for (const tool of ["get_operation", "get_dossier", "get_checklist", "get_dispatch_status"]) expect(await call(tool)).toMatchObject(okAnswer);
      window = await call("get_counterpart_profile", { party: "IMPORTER" });
      expect(await call("get_counterpart_profile", { party: "SUPPLIER" })).toMatchObject(okAnswer);
      expect(await call("assign_responsible", { observationId: observation.observationId, responsibleParty: "SUPPLIER", rationale: "The supplier issued the packing list." })).toMatchObject(okAnswer);
    },
    without,
  );
  return { unlinked, window };
}

async function documentsScenario(): Promise<TableName[]> {
  const world = await toolWorld();
  await seedFirm(world.stores);
  const version = await fileTestVersion(world.stores, { docType: "PACKING_LIST", party: "SUPPLIER" });
  const reading: Reading = { readingId: "rd-pl", status: "RECOGNIZED", docType: "PACKING_LIST", matchedBy: "SHA256", confidence: 0.96, fields: { invoiceNumber: "QBT-2026-0917", grossWeightKg: 12840, packages: 40 }, observations: [], readerVersion: "1.0.0" };
  const target = createDocumentsTarget(
    world.deps,
    documentsImplementations({ reader: () => ({ createReading: async () => reading }), sourceUrl: async (key) => `https://documents.example.invalid/${key}`, newToken: () => "Tq3x9vY2bN7mK4pL8rS1wE6uI0oA5dF3gH7jZ2cV9xB" }),
  );
  const { token } = await world.openTurn("DOCUMENT_READ");
  const call = (tool: string, input: Record<string, unknown>) => target.handle({ sessionToken: token, ...input }, gatewayContext(`documents___${tool}`));
  return asLinked(world.stores.client, "ToolDocuments", async () => {
    expect(await call("read_document", { docVersionId: version.docVersionId })).toMatchObject(okAnswer);
    expect(await call("create_upload_link", { docTypes: ["CERTIFICATE_OF_ORIGIN"] })).toMatchObject(okAnswer);
  });
}

const SUPPLIER_EMAIL = "Hello, for invoice QBT-2026-0917 we still need the packing list and the certificate of origin. Please send them by October 19, 10:00 (Asia/Shanghai). Thank you.";

async function messagingScenario(without: readonly TableName[] = []): Promise<{ readonly unlinked: TableName[]; readonly answers: unknown[] }> {
  const world = await messagingWorld();
  const sourceMessageId = await world.inbound("Escribile a supplier-qingdao-ops2@sim.legajo.demo.craftech.io", "2026-10-16T09:50:00-03:00");
  const { token } = await world.open("IMPORTER_MESSAGE", FRI_10_QINGDAO, [{ tool: "get_dossier", output: DOSSIER }]);
  const answers: unknown[] = [];
  const unlinked = await asLinked(
    world.stores.client,
    "ToolMessaging",
    async () => {
      answers.push(await world.gateway("send_email", { sessionToken: token, recipientRole: "SUPPLIER", kind: "DOCS_REQUEST", text: SUPPLIER_EMAIL, refs: { docTypes: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] } }));
      answers.push(await world.gateway("send_whatsapp", { sessionToken: token, recipientRole: "IMPORTER", kind: "REPLY", text: "Le escribimos al proveedor por la operación 4471." }));
      answers.push(await world.gateway("propose_supplier_contact", { sessionToken: token, email: "supplier-qingdao-ops2@sim.legajo.demo.craftech.io", sourceMessageId }));
    },
    without,
  );
  return { unlinked, answers };
}

async function followupsScenario(): Promise<TableName[]> {
  const world = await followupsWorld();
  const { token } = await world.openTurn("SUPPLIER_EMAIL");
  return asLinked(world.stores.client, "ToolFollowups", async () => {
    expect(await world.target.invoke("schedule_followup", { sessionToken: token, party: "SUPPLIER", atSim: "2026-10-17T10:00:00+08:00", reason: "PROMISED_BY_SUPPLIER" })).toMatchObject(okAnswer);
    expect(await world.target.invoke("schedule_followup", { sessionToken: token, party: "IMPORTER", atSim: "2026-10-14T20:00:00-03:00", reason: "IMPORTER_ASKED_LATER" })).toMatchObject(okAnswer);
    expect(await world.target.invoke("estimate_delay_risk", { sessionToken: token })).toMatchObject(okAnswer);
  });
}

/** `ToolHandoff` with the real outbound pipeline (the firm's email, `legajo_escalado`) over the restricted client. */
function handoffTarget(world: MessagingWorld): GatewayTargetRuntime {
  const wall = new Date(REAL_NOW);
  const deps: ToolDeps = {
    connector: world.stores.connector,
    sessionKey: () => TEST_SESSION_KEY,
    wallClock: () => new Date(wall.getTime()),
    loggerFor: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => world.lines.push(line), now: () => wall }),
  };
  return createHandoffTarget(deps, handoffImplementations({ send: (request, call) => sendOutbound(world.deps, request, call), agentMode: "SCRIPTED" }));
}

async function handoffScenario(): Promise<TableName[]> {
  const world = await messagingWorld();
  await seedSettings(world.stores);
  await world.inbound("¿Puedo hablar con alguien del estudio?", "2026-10-15T09:50:00-03:00");
  const target = handoffTarget(world);
  const escalation = await world.open("IMPORTER_MESSAGE", THU_10_AR, [{ tool: "get_dossier", output: DOSSIER }]);
  for (const docType of ["COMMERCIAL_INVOICE", "PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] as const) await world.stores.connector.documents.updateDocument(OPERATION, docType, { status: "VALID" });
  const approval = await world.open("DOCUMENT_READ", THU_10_AR, [{ tool: "get_dossier", output: DOSSIER }]);
  const unlinked = await asLinked(world.stores.client, "ToolHandoff", async () => {
    expect(await target.invoke("escalate_to_broker", { sessionToken: escalation.token, reason: "IMPORTER_ASKED", summary: "El importador pide hablar con una persona.", notifyImporter: true })).toMatchObject({ ok: true, emailSent: true });
    expect(await target.invoke("request_approval", { sessionToken: approval.token, summary: "Los tres documentos están validados." })).toEqual({ ok: true, dossierStatus: "READY_FOR_REVIEW" });
  });
  // Both of the firm's emails (the escalation report and the dossier ready for review) left through SES.
  expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(2);
  return unlinked;
}

const SCENARIOS: Readonly<Record<ToolTarget, () => Promise<TableName[]>>> = {
  operations: async () => (await operationsScenario()).unlinked,
  documents: documentsScenario,
  messaging: async () => (await messagingScenario()).unlinked,
  followups: followupsScenario,
  handoff: handoffScenario,
};

describe("tool Lambdas reach only the tables they link (infra/iam-capabilities.ts)", () => {
  it("every Gateway target has a scenario", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...ToolTarget.options].sort());
  });

  for (const target of ToolTarget.options) {
    it(`${TOOL_FUNCTIONS[target]} runs the tools of \`${target}\` over its linked tables only`, async () => {
      expect(await SCENARIOS[target]()).toEqual([]);
    });
  }

  it("the guard catches a table that is not linked, even where the code swallows the error", async () => {
    const operations = await operationsScenario(["Conversations"]);
    expect(operations.unlinked).toEqual(["Conversations"]);
    expect(operations.window).toMatchObject({ ok: true, importer: { windowOpen: false } });
    const messaging = await messagingScenario(["Firms"]);
    expect(messaging.unlinked).toContain("Firms");
  });

  it("with Conversations linked, get_counterpart_profile sees the importer's open window", async () => {
    expect((await operationsScenario()).window).toMatchObject({ ok: true, importer: { windowOpen: true } });
  });
});
