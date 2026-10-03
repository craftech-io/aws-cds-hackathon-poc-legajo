// Local flows of the findings of the reader (docs/flows-catalog.md, areas C and D): the correction
// request in the same thread, the corrected version, the two-attempt rule, the responsibility matrix
// and a scripted assignment that departs from it. The reader mock reads each PDF the supplier sends
// (SimMail with the seeded behaviour, or a mail the test writes) and returns the observation of its
// ground truth; the plans read the dossier and call `assign_responsible` as the model would.
import { describe, expect, it } from "vitest";
import { READ_DOSSIER, READ_OPERATION, assign, correctionEmail, noActionNeeded, observationOf, reply } from "./support/plans";
import type { Plan } from "./support/scripted-harness";
import { DELEGATED, delegateToSupplier, untilSupplierWrites } from "./support/stories";
import { supplierMail } from "./support/supplier-mail";
import { useFlowWorld } from "./support/lifecycle";
import type { FlowWorld } from "./support/world";

const worlds = useFlowWorld();

const open = (plans: Parameters<typeof worlds.open>[0]): Promise<FlowWorld> => worlds.open(plans);

const emailsOut = async (flow: FlowWorld, operationId: string) => (await flow.messages(operationId)).filter((message) => message.direction === "OUT" && message.channel === "EMAIL");
const observationsOf = (flow: FlowWorld, operationId: string) => flow.data.documents.listObservations(operationId);

/** The SUPPLIER_EMAIL turn of a reply with a finding: the supplier corrects it, the importer is told (FL-022). */
function correctionPlan(docType: string, what: string): Plan {
  return { steps: [READ_OPERATION, READ_DOSSIER, assign(docType, "SUPPLIER"), correctionEmail(docType, what), noActionNeeded(docType)], note: "Pedí la corrección al proveedor." };
}

const INFORMED: Plan = { steps: [READ_DOSSIER, reply("REPLY", "Llegó la versión corregida.")], note: "Avisé al importador." };

describe("observation flows", () => {
  it("[FL-022] packing list v1 of op-4471 with GROSS_WEIGHT_MISMATCH (12,480 vs 12,840 kg): matrix SUPPLIER, CORRECTION_REQUEST in the same thread, NO_ACTION_NEEDED to the importer, both with the observation", async () => {
    const flow = await open({ "4471": { ...DELEGATED, SUPPLIER_EMAIL: [correctionPlan("PACKING_LIST", "packing list")] } });

    await delegateToSupplier(flow, "op-4471");
    await untilSupplierWrites(flow, "op-4471");

    const packing = (await flow.data.documents.listDocuments("op-4471")).find((document) => document.docType === "PACKING_LIST");
    expect(packing?.status).toBe("WITH_OBSERVATION");
    const [observation] = await observationsOf(flow, "op-4471");
    expect(observation).toMatchObject({ code: "GROSS_WEIGHT_MISMATCH", expected: "12,840 kg", found: "12,480 kg", responsibleParty: "SUPPLIER", matrixDefault: "SUPPLIER", matchesMatrix: true });
    const [request, correction] = await emailsOut(flow, "op-4471");
    expect(correction).toMatchObject({ kind: "CORRECTION_REQUEST", status: "SENT", refs: { observationIds: [observation?.observationId] } });
    const sent = flow.aws.sesMessages.find((mail) => mail.messageId === correction?.providerMessageId);
    expect(sent?.input.Content?.Simple?.Headers?.find((header) => header.Name === "In-Reply-To")?.Value).toBeDefined();
    expect(sent?.input.Content?.Simple?.Attachments ?? []).toEqual([]);
    expect(request?.kind).toBe("DOCS_REQUEST");
    const notice = (await flow.messages("op-4471")).find((message) => message.kind === "NO_ACTION_NEEDED");
    expect(notice).toMatchObject({ channel: "WHATSAPP", refs: { observationIds: [observation?.observationId] } });
  });

  it("[FL-022] the CORRECTION_REQUEST that names the observation leaves it CORRECTION_REQUESTED with attempts 1; the NO_ACTION_NEEDED to the importer counts nothing", async () => {
    const flow = await open({ "4471": { ...DELEGATED, SUPPLIER_EMAIL: [correctionPlan("PACKING_LIST", "packing list")] } });

    await delegateToSupplier(flow, "op-4471");
    await untilSupplierWrites(flow, "op-4471");

    const [observation] = await observationsOf(flow, "op-4471");
    expect(observation).toMatchObject({ status: "CORRECTION_REQUESTED", attempts: 1, matchesMatrix: true });
    expect(observation?.history.map((entry) => entry.status)).toEqual(["OPEN", "CORRECTION_REQUESTED"]);
  });

  it("[FL-023] the corrected packing list v2 without observations resolves the observation by version 2, the document is VALID at version 2 and the turn tells the importer", async () => {
    const flow = await open({ "4471": { ...DELEGATED, SUPPLIER_EMAIL: [correctionPlan("PACKING_LIST", "packing list"), INFORMED] } });
    await delegateToSupplier(flow, "op-4471");
    await untilSupplierWrites(flow, "op-4471");

    await untilSupplierWrites(flow, "op-4471", 2);

    const packing = (await flow.data.documents.listDocuments("op-4471")).find((document) => document.docType === "PACKING_LIST");
    expect(packing).toMatchObject({ status: "VALID", currentVersion: 2 });
    const [observation] = await observationsOf(flow, "op-4471");
    expect(observation).toMatchObject({ status: "RESOLVED", lastDocVersionId: packing?.currentDocVersionId });
    expect(observation?.history.at(-1)).toMatchObject({ status: "RESOLVED", docVersionId: packing?.currentDocVersionId });
    const informed = flow.harness.turns.filter((turn) => turn.envelope.event.type === "SUPPLIER_EMAIL");
    expect(informed).toHaveLength(2);
    expect((await flow.messages("op-4471")).some((message) => message.kind === "REPLY" && message.body === "Llegó la versión corregida.")).toBe(true);
  });

  it("[FL-024] SEEDED_ERROR_TWICE (op-4479): the corrected certificate comes back with the same code, attempts 2 escalates OBSERVATION_ATTEMPTS by code, the firm's mailbox gets it and no third CORRECTION_REQUEST leaves", async () => {
    const informed: Plan = { steps: [READ_DOSSIER], note: "La corrección volvió con el mismo error: lo tiene el estudio." };
    const flow = await open({ "4479": { ...DELEGATED, SUPPLIER_EMAIL: [correctionPlan("CERTIFICATE_OF_ORIGIN", "certificate of origin"), informed] } });
    await delegateToSupplier(flow, "op-4479");
    await untilSupplierWrites(flow, "op-4479");
    const [requested] = await observationsOf(flow, "op-4479");
    expect(requested).toMatchObject({ status: "CORRECTION_REQUESTED", attempts: 1 });

    await untilSupplierWrites(flow, "op-4479", 2, 12);

    const [observation] = await observationsOf(flow, "op-4479");
    expect(observation).toMatchObject({ code: requested?.code, status: "ESCALATED", attempts: 2 });
    const escalations = await flow.data.operations.listEscalations("op-4479", { status: "OPEN" });
    expect(escalations.map((escalation) => escalation.reason)).toContain("OBSERVATION_ATTEMPTS");
    const firm = await flow.data.firms.getFirm(flow.firmId);
    const mailbox = await flow.data.conversations.listMailbox(firm.mailboxAddress);
    expect(mailbox.some((mail) => mail.operationId === "op-4479")).toBe(true);
    expect((await emailsOut(flow, "op-4479")).filter((message) => message.kind === "CORRECTION_REQUEST")).toHaveLength(1);
  });

  it("[FL-039] invoice of op-4484 with BUYER_DATA_MISMATCH: the matrix says IMPORTER first; the agent asks the importer without asking for tax ids, then hands it to the supplier with the registry data", async () => {
    const askImporter: Plan = {
      steps: [READ_OPERATION, READ_DOSSIER, assign("COMMERCIAL_INVOICE", "IMPORTER"), { tool: "send_whatsapp", input: (context) => ({ recipientRole: "IMPORTER", kind: "CORRECTION_REQUEST", text: "En la factura de la operación 4484 el comprador figura con otro nombre del que tenemos registrado. ¿Nos confirmás que el comprador correcto es el del registro?", refs: { docTypes: ["COMMERCIAL_INVOICE"], observationIds: [observationOf(context, "COMMERCIAL_INVOICE").observationId] } }) }],
      note: "Consulté al importador.",
    };
    const toSupplier: Plan = { steps: [READ_OPERATION, READ_DOSSIER, assign("COMMERCIAL_INVOICE", "SUPPLIER"), correctionEmail("COMMERCIAL_INVOICE", "commercial invoice")], note: "Pedí la corrección al proveedor." };
    const flow = await open({ "4484": { IMPORTER_MESSAGE: [askImporter, toSupplier] } });
    await flow.console().registry.authorization.set({ importerId: "imp-cuyo", supplierId: "sup-elbhafen", authorized: true });

    await flow.say("imp-cuyo", "4484", "¿Cómo viene la 4484?");
    const [observation] = await observationsOf(flow, "op-4484");
    expect(observation).toMatchObject({ code: "BUYER_DATA_MISMATCH", responsibleParty: "IMPORTER", matchesMatrix: true });
    const question = (await flow.messages("op-4484")).find((message) => message.kind === "CORRECTION_REQUEST" && message.channel === "WHATSAPP");
    expect(question?.body).not.toMatch(/CUIT|CUIL|DNI/i);

    await flow.say("imp-cuyo", "4484", "Sí, es el del registro.");

    const [handed] = await observationsOf(flow, "op-4484");
    expect(handed).toMatchObject({ responsibleParty: "SUPPLIER" });
    expect((await emailsOut(flow, "op-4484")).map((message) => message.kind)).toEqual(["CORRECTION_REQUEST"]);
  });

  it("[FL-039] handing BUYER_DATA_MISMATCH to the supplier after the importer confirmed keeps matchesMatrix true: the row says IMPORTER, then SUPPLIER", async () => {
    const askImporter: Plan = { steps: [READ_DOSSIER, assign("COMMERCIAL_INVOICE", "IMPORTER")], note: "Consulté al importador." };
    const toSupplier: Plan = { steps: [READ_DOSSIER, assign("COMMERCIAL_INVOICE", "SUPPLIER")], note: "Se lo pasé al proveedor." };
    const flow = await open({ "4484": { IMPORTER_MESSAGE: [askImporter, toSupplier] } });

    await flow.say("imp-cuyo", "4484", "¿Cómo viene la 4484?");
    await flow.say("imp-cuyo", "4484", "Sí, es el del registro.");

    const [first, second] = flow.harness.turns.filter((turn) => turn.envelope.event.operation === "4484").map((turn) => turn.calls[1]?.output);
    expect(first).toMatchObject({ ok: true, matchesMatrix: true, matrixDefault: "IMPORTER", flaggedForReview: false });
    expect(second).toMatchObject({ ok: true, matchesMatrix: true, matrixDefault: "SUPPLIER", flaggedForReview: false });
    const [observation] = await observationsOf(flow, "op-4484");
    expect(observation).toMatchObject({ responsibleParty: "SUPPLIER", matrixDefault: "SUPPLIER", matchesMatrix: true, flaggedForReview: false });
  });

  it("[FL-041] certificate of op-4486 with MISSING_SIGNATURE: assign SUPPLIER, CORRECTION_REQUEST to the supplier and NO_ACTION_NEEDED to the importer, like FL-022", async () => {
    const flow = await open({ "4486": { SUPPLIER_EMAIL: [correctionPlan("CERTIFICATE_OF_ORIGIN", "certificate of origin")] } });

    await supplierMail(flow, { operationId: "op-4486", text: "Hello,\nPlease find the certificate of origin attached.\nRegards.", pdfs: [{ templateOperation: "op-4486", docType: "CERTIFICATE_OF_ORIGIN", version: 1 }], inReplyTo: null });
    // 21:30 in Shenzhen: the request waits for 09:00 there (CP-HOURS-SUPPLIER).
    await flow.advance({ next: true });

    const certificate = (await flow.data.documents.listDocuments("op-4486")).find((document) => document.docType === "CERTIFICATE_OF_ORIGIN");
    expect(certificate?.status).toBe("WITH_OBSERVATION");
    const [observation] = await observationsOf(flow, "op-4486");
    expect(observation).toMatchObject({ code: "MISSING_SIGNATURE", responsibleParty: "SUPPLIER", matchesMatrix: true });
    expect((await emailsOut(flow, "op-4486")).map((message) => message.kind)).toEqual(["CORRECTION_REQUEST"]);
    expect((await flow.messages("op-4486")).some((message) => message.kind === "NO_ACTION_NEEDED")).toBe(true);
  });

  it("[FL-042] a scripted assignment of IMPORTER where the matrix says SUPPLIER answers matchesMatrix false and flaggedForReview; the console shows it flagged", async () => {
    const departs: Plan = { steps: [READ_DOSSIER, assign("CERTIFICATE_OF_ORIGIN", "IMPORTER")], note: "Asigné al importador." };
    const flow = await open({ "4486": { SUPPLIER_EMAIL: [departs] } });

    await supplierMail(flow, { operationId: "op-4486", text: "Hello,\nCertificate attached.\nRegards.", pdfs: [{ templateOperation: "op-4486", docType: "CERTIFICATE_OF_ORIGIN", version: 1 }], inReplyTo: null });

    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.type === "SUPPLIER_EMAIL");
    expect(turn?.calls[1]?.output).toMatchObject({ ok: true, matchesMatrix: false, flaggedForReview: true });
    const [observation] = await observationsOf(flow, "op-4486");
    expect(observation).toMatchObject({ responsibleParty: "IMPORTER", matchesMatrix: false, flaggedForReview: true });
    const view = await flow.console().operations.get({ operationId: "op-4486" });
    expect(view.observations.find((candidate) => candidate.observationId === observation?.observationId)).toMatchObject({ flaggedForReview: true });
  });
});
