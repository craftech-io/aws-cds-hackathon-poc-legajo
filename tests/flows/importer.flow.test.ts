// Local flows of the importer on WhatsApp (docs/flows-catalog.md, areas A and B): opt-in, the
// DOCS_REQUEST template, delegating to the supplier, opting out, a PDF by WhatsApp and the choice
// between two open operations. Each runs on the in-process world of the seed (support/world.ts): the
// importer writes through `InboundWhatsApp` with the phone simulator's signed envelope, milestones fire
// through the clock, the worker hands its own envelope to the scripted Harness and every send goes
// through the outbound pipeline to the simulated transport.
import { describe, expect, it } from "vitest";
import { CONTACT_CONFIRMATION, DOCS_REQUEST_PLAN, READ_DOSSIER, READ_OPERATION, READ_SUPPLIER, SEND_DOCS_REQUEST, escalate, field, reply } from "./support/plans";
import type { Plan } from "./support/scripted-harness";
import { useFlowWorld } from "./support/lifecycle";
import type { FlowWorld } from "./support/world";

const worlds = useFlowWorld();

const open = (plans: Parameters<typeof worlds.open>[0]): Promise<FlowWorld> => worlds.open(plans);

const SENT = ["SENT", "DELIVERED", "READ"];

/** `get_counterpart_profile(SUPPLIER)` and the confirmation with the masked address it returned (FL-011). */
const CONFIRM_CONTACT_PLAN: Plan = { steps: [READ_SUPPLIER, CONTACT_CONFIRMATION], note: "Pedí confirmar el contacto del proveedor." };

describe("importer flows on WhatsApp", () => {
  it("[FL-007] the DOCS_REQUEST milestone of op-4471 at 15/10 10:00 sends legajo_docs_pendientes with grounded parameters, the upload link and three nonces", async () => {
    const flow = await open({ "4471": { MILESTONE: [DOCS_REQUEST_PLAN] } });

    await flow.advance({ next: true });

    expect((await flow.simNow()).toISOString()).toBe(new Date("2026-10-15T10:00:00-03:00").toISOString());
    const timer = await flow.data.timers.findTimer("op-4471", "TIMER#MILESTONE#DOCS_REQUEST");
    expect(timer).toMatchObject({ status: "FIRED", firedBy: "CLOCK" });
    const sent = (await flow.messages("op-4471")).filter((message) => message.direction === "OUT");
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request).toMatchObject({ channel: "WHATSAPP", kind: "DOCS_REQUEST", author: "AGENT", template: { name: "legajo_docs_pendientes" } });
    expect(SENT).toContain(request?.status);
    expect(Date.parse(request?.sentAtSim ?? "")).toBe(Date.parse("2026-10-15T10:00:00-03:00"));
    expect(request?.template?.params).toEqual(["Estudio Delta", "4471", "Austral Aurora", "22/10 08:00", "packing list y certificado de origen"]);
    expect(request?.buttons.map((button) => button.action)).toEqual(["UPLOAD", "SUPPLIER_SENDS", "QUESTION", "OPT_OUT"]);
    expect(request?.buttons.filter((button) => button.nonce !== undefined)).toHaveLength(3);
    const token = /\/u\/([A-Za-z0-9_-]+)$/.exec(request?.buttons[0]?.url ?? "")?.[1] ?? "";
    expect(await flow.data.runtime.getUploadLink(token)).toMatchObject({ operationId: "op-4471", importerId: "imp-norpampa" });
    const allow = (await flow.data.audit.listByOperation("op-4471")).find((row) => row.decision === "ALLOW" && row.action === "SEND_WHATSAPP");
    expect(allow?.ruleIds).toEqual(expect.arrayContaining(["CP-OPTIN", "CP-HOURS-AR", "CP-ONE-PER-DAY", "CP-WA-24H"]));
    expect(flow.harness.turns.filter((turn) => turn.envelope.event.operation === "4471").map((turn) => turn.envelope.event.type)).toEqual(["MILESTONE"]);
  });

  it("[FL-007] after the DOCS_REQUEST, DOC#PACKING_LIST and DOC#CERTIFICATE_OF_ORIGIN carry requestedFrom IMPORTER and the instant of the request", async () => {
    const flow = await open({ "4471": { MILESTONE: [DOCS_REQUEST_PLAN] } });

    await flow.advance({ next: true });

    const documents = await flow.data.documents.listDocuments("op-4471");
    const requested = documents.filter((document) => document.requestedFrom === "IMPORTER").map((document) => document.docType);
    expect(requested.sort()).toEqual(["CERTIFICATE_OF_ORIGIN", "PACKING_LIST"]);
    for (const document of documents.filter((candidate) => candidate.requestedFrom === "IMPORTER")) {
      expect(Date.parse(document.lastRequestedAtSim ?? "")).toBe(Date.parse("2026-10-15T10:00:00-03:00"));
    }
    expect(documents.find((document) => document.docType === "COMMERCIAL_INVOICE")?.requestedFrom).not.toBe("IMPORTER");
  });

  it("[FL-002] the DOCS_REQUEST of op-4473 (no opt-in) is denied by CP-OPTIN and the agent escalates OTHER; no WhatsApp leaves", async () => {
    const flow = await open({ "4473": { MILESTONE: [{ steps: [READ_OPERATION, READ_DOSSIER, SEND_DOCS_REQUEST, escalate("OTHER", "El importador no tiene opt-in de WhatsApp.")], note: "Sin opt-in: escalé." }] } });

    await flow.fire("op-4473", "DOCS_REQUEST");

    const [turn] = flow.harness.turns;
    expect(turn?.calls.map((call) => call.tool)).toEqual(["get_operation", "get_dossier", "send_whatsapp", "escalate_to_broker"]);
    expect(turn?.calls[2]?.output).toMatchObject({ ok: false, error: { code: "POLICY_DENIED" } });
    expect((await flow.messages("op-4473")).filter((message) => message.direction === "OUT")).toEqual([]);
    expect(flow.aws.whatsappSent).toEqual([]);
    const deny = (await flow.data.audit.listByOperation("op-4473")).filter((row) => row.decision === "DENY");
    expect(deny.flatMap((row) => row.ruleIds ?? [])).toContain("CP-OPTIN");
    const open4473 = await flow.data.operations.listEscalations("op-4473", { status: "OPEN" });
    expect(open4473.map((escalation) => escalation.reason)).toEqual(["OTHER"]);
    const { escalations } = await flow.console().escalations.list({});
    expect(escalations.some((escalation) => escalation.operationId === "op-4473")).toBe(true);
  });

  it("[FL-011] the SUPPLIER_SENDS button answers a CONTACT_CONFIRMATION with the masked ACTIVE contact and three nonces", async () => {
    const flow = await open({ "4471": { MILESTONE: [DOCS_REQUEST_PLAN], IMPORTER_MESSAGE: [CONFIRM_CONTACT_PLAN] } });
    await flow.advance({ next: true });

    const tapped = await flow.tap("op-4471", "SUPPLIER_SENDS");

    expect(tapped.summary.records[0]?.messages[0]).toMatchObject({ operationId: "op-4471" });
    const messages = await flow.messages("op-4471");
    const inbound = messages.filter((message) => message.direction === "IN");
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.body).toBe("Los manda el proveedor");
    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.type === "IMPORTER_MESSAGE");
    expect(turn?.envelope.event.operation).toBe("4471");
    const confirmation = messages.find((message) => message.kind === "CONTACT_CONFIRMATION");
    expect(SENT).toContain(confirmation?.status);
    expect(confirmation?.body).toContain("s***@sim.legajo.demo.craftech.io");
  });

  it("[FL-011] the CONTACT_CONFIRMATION carries CONFIRM_CONTACT, REJECT_CONTACT and OTHER_CONTACT, three nonces, the first two bound to the ACTIVE contact", async () => {
    const flow = await open({ "4471": { MILESTONE: [DOCS_REQUEST_PLAN], IMPORTER_MESSAGE: [CONFIRM_CONTACT_PLAN] } });
    await flow.advance({ next: true });

    await flow.tap("op-4471", "SUPPLIER_SENDS");

    const confirmation = (await flow.messages("op-4471")).find((message) => message.kind === "CONTACT_CONFIRMATION");
    expect(confirmation?.buttons.map((button) => button.action)).toEqual(["CONFIRM_CONTACT", "REJECT_CONTACT", "OTHER_CONTACT"]);
    const nonces = (confirmation?.buttons ?? []).map((button) => button.nonce ?? "");
    expect(new Set(nonces.filter((nonce) => nonce !== "")).size).toBe(3);
    const [confirm, reject] = await Promise.all(nonces.slice(0, 2).map((nonce) => flow.data.runtime.getNonce(nonce)));
    const operation = await flow.data.operations.getOperation("op-4471");
    for (const nonce of [confirm, reject]) expect(nonce).toMatchObject({ operationId: "op-4471", payload: { supplierId: operation.supplierId, contactId: "ctc-qingdao-1" } });
  });

  it("[FL-016] OPT_OUT and the exact keyword BAJA revoke the consent without a turn, confirm with the fixed text and escalate OPTED_OUT; the next milestone is denied by CP-OPTOUT", async () => {
    const flow = await open({ "4471": { MILESTONE: [DOCS_REQUEST_PLAN, DOCS_REQUEST_PLAN] } });
    await flow.advance({ next: true });
    const turnsBefore = flow.harness.turns.length;

    await flow.tap("op-4471", "OPT_OUT");

    expect(flow.harness.turns).toHaveLength(turnsBefore);
    const consent = await flow.data.parties.getConsent("imp-norpampa");
    expect(consent?.revokedAt).toBeDefined();
    const confirmation = (await flow.messages("op-4471")).filter((message) => message.kind === "OPT_OUT_CONFIRMATION");
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0]?.author).toBe("SYSTEM");
    expect((await flow.data.operations.listEscalations("op-4471", { status: "OPEN" })).map((escalation) => escalation.reason)).toContain("OPTED_OUT");

    await flow.fire("op-4471", "FOLLOWUP");
    const denied = (await flow.data.audit.listByOperation("op-4471")).filter((row) => row.decision === "DENY");
    expect(denied.flatMap((row) => row.ruleIds ?? [])).toContain("CP-OPTOUT");
  });

  it("[FL-016] the exact keyword BAJA from a phone with consent opts out the same way", async () => {
    const flow = await open({});
    const phone = await flow.phoneOf("imp-patagonia");

    await flow.phone(phone, { type: "text", text: "BAJA" });

    expect(flow.harness.turns).toEqual([]);
    expect((await flow.data.parties.getConsent("imp-patagonia"))?.revokedAt).toBeDefined();
    const confirmations = (await Promise.all(["op-4474", "op-4475", "op-4482", "op-4490"].map((operationId) => flow.messages(operationId)))).flat().filter((message) => message.kind === "OPT_OUT_CONFIRMATION");
    expect(confirmations).toHaveLength(1);
  });

  it("[FL-019] free text of an importer with several open operations gets a deterministic OPERATION_CHOICE and no turn; the choice runs one turn on the chosen operation with the original text", async () => {
    const flow = await open({ "4475": { IMPORTER_MESSAGE: [{ steps: [READ_DOSSIER], note: "Leí el legajo." }] } });
    const phone = await flow.phoneOf("imp-patagonia");

    const asked = await flow.phone(phone, { type: "text", text: "¿ya llegó lo del proveedor?" });

    expect(asked.summary.records[0]?.messages[0]).toMatchObject({ outcome: "OPERATION_CHOICE", operationId: "op-4474" });
    expect(flow.harness.turns).toEqual([]);
    const choice = (await flow.messages("op-4474")).find((message) => message.kind === "OPERATION_CHOICE");
    expect(choice?.author).toBe("SYSTEM");
    expect(choice?.buttons.map((button) => button.title)).toEqual(["Operación 4474", "Operación 4475", "Operación 4482", "Operación 4490"]);

    const chosen = await flow.choose("imp-patagonia", "4475");

    expect(chosen.summary.records[0]?.messages[0]).toMatchObject({ outcome: "CHOICE_APPLIED", operationId: "op-4475" });
    expect(flow.harness.turns.map((turn) => [turn.envelope.event.type, turn.envelope.event.operation])).toEqual([["IMPORTER_MESSAGE", "4475"]]);
    expect(flow.harness.turns[0]?.envelope.text).toContain("¿ya llegó lo del proveedor?");
  });

  it("[FL-017] a packing list PDF from the phone simulator goes through the scan, the choice of operation and the in-process reader: version from WHATSAPP, PACKING_LIST VALID and a DOCUMENT_READ turn that tells the importer", async () => {
    const flow = await open({ "4474": { DOCUMENT_READ: [{ steps: [READ_DOSSIER, reply("REPLY", (context) => `Recibimos el ${field(context.calls, "get_dossier", "documents", "1", "label")}, gracias.`)], note: "Avisé la recepción." }] } });

    await flow.console().simulator.attachDocument({ importerId: "imp-patagonia", source: { kind: "SYNTHETIC", operationId: "op-4474", docType: "PACKING_LIST" } });
    await flow.entries.settle();
    await flow.choose("imp-patagonia", "4474");

    const documents = await flow.data.documents.listDocuments("op-4474");
    expect(documents.find((document) => document.docType === "PACKING_LIST")?.status).toBe("VALID");
    const versions = await flow.data.documents.listVersions("op-4474", "PACKING_LIST");
    expect(versions.map((version) => version.source.channel)).toEqual(["WHATSAPP"]);
    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.type === "DOCUMENT_READ");
    expect(turn?.envelope.event.operation).toBe("4474");
    const replies = (await flow.messages("op-4474")).filter((message) => message.kind === "REPLY");
    expect(replies.map((message) => message.body)).toEqual(["Recibimos el packing list, gracias."]);
  });
});
