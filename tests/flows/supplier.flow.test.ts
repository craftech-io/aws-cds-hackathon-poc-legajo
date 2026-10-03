// Local flows of the supplier by email (docs/flows-catalog.md, areas B and C): the first request in
// English, contacts proposed by the importer, replies with the right, the wrong or an unknown PDF,
// promises, silence and a permanent bounce. The supplier simulator answers our mail from its seeded
// behaviour (SimMail in process, stage/entries.ts); its reply reaches `InboundEmail` through the
// mailroom; the reader mock reads each PDF in process; SES events go to `ChannelEvents`.
import { describe, expect, it } from "vitest";
import { CONTACT_CONFIRMATION, EMAIL_DOCS_REQUEST, EMAIL_REMINDER, READ_DOSSIER, READ_OPERATION, READ_SUPPLIER, escalate, field, outputOf, reply, supplierEmail } from "./support/plans";
import type { Plan } from "./support/scripted-harness";
import { sesEventOf } from "./support/stage/mailroom";
import { DELEGATED, delegateToSupplier, untilSupplierWrites } from "./support/stories";
import { useFlowWorld } from "./support/lifecycle";
import type { FlowWorld } from "./support/world";

const worlds = useFlowWorld();

const open = (plans: Parameters<typeof worlds.open>[0]): Promise<FlowWorld> => worlds.open(plans);

const emailsOut = async (flow: FlowWorld, operationId: string) => (await flow.messages(operationId)).filter((message) => message.direction === "OUT" && message.channel === "EMAIL");
const header = (flow: FlowWorld, index: number, name: string) => flow.aws.sesMessages[index]?.input.Content?.Simple?.Headers?.find((candidate) => candidate.Name === name)?.Value;

describe("supplier flows by email", () => {
  it("[FL-012] the first request goes to Qingdao in English from op-4471@, DEFERRED by CP-HOURS-SUPPLIER at 21:00 Qingdao and SENT at 16/10 09:00 Qingdao with X-Legajo-Request and [Op 4471]", async () => {
    const flow = await open({ "4471": { MILESTONE: [DELEGATED.MILESTONE[0]], IMPORTER_MESSAGE: [{ steps: [READ_OPERATION, READ_DOSSIER, EMAIL_DOCS_REQUEST, reply("REPLY", "Le escribimos al proveedor a primera hora de Qingdao.")], note: "Pedí al proveedor." }] } });
    await flow.advance({ next: true });

    await flow.tap("op-4471", "SUPPLIER_SENDS");

    const deferred = (await emailsOut(flow, "op-4471"))[0];
    expect(deferred).toMatchObject({ kind: "DOCS_REQUEST", status: "DEFERRED", counterpart: "SUPPLIER" });
    const [turn] = flow.harness.turns.filter((candidate) => candidate.envelope.event.type === "IMPORTER_MESSAGE");
    expect(turn?.calls[2]?.output).toMatchObject({ status: "DEFERRED", policyResult: { ruleIds: ["CP-HOURS-SUPPLIER"], nextAllowedAt: "2026-10-16T09:00:00+08:00" } });
    expect(flow.aws.sesMessages).toEqual([]);

    await flow.advance({ next: true });

    expect((await flow.simNow()).toISOString()).toBe(new Date("2026-10-16T09:00:00+08:00").toISOString());
    const [sent] = await emailsOut(flow, "op-4471");
    expect(sent).toMatchObject({ kind: "DOCS_REQUEST", status: "SENT", to: "supplier-qingdao@sim.legajo.demo.craftech.io" });
    expect(sent?.providerMessageId).toBe(flow.aws.sesMessages[0]?.messageId);
    const operation = await flow.data.operations.getOperation("op-4471");
    expect(flow.aws.sesMessages[0]?.input.FromEmailAddress).toContain(operation.threadAddress);
    expect(flow.aws.sesMessages[0]?.input.Content?.Simple?.Subject?.Data).toMatch(/^\[Op 4471\] /);
    expect(header(flow, 0, "X-Legajo-Request")).toBeDefined();
    const body = flow.aws.sesMessages[0]?.input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(body).toContain("QBT-2026-0917");
    expect(body).toContain("2026-10-18 17:00 (Asia/Shanghai)");
  });

  it("[FL-012] the importer's CONFIRM_CONTACT on the known contact: confirmedBy IMPORTER, AGENT_TURN(CONTACT_CONFIRMED), the request to the supplier and DOC#…requestedFrom SUPPLIER once it goes out", async () => {
    const confirmPlan: Plan = { steps: [READ_SUPPLIER, CONTACT_CONFIRMATION], note: "Pedí confirmar el contacto del proveedor." };
    const confirmedPlan: Plan = { steps: [READ_OPERATION, READ_DOSSIER, EMAIL_DOCS_REQUEST, reply("REPLY", "Le escribimos al proveedor a primera hora de Qingdao.")], note: "Pedí al proveedor." };
    const flow = await open({ "4471": { MILESTONE: [DELEGATED.MILESTONE[0]], IMPORTER_MESSAGE: [confirmPlan], CONTACT_CONFIRMED: [confirmedPlan] } });
    await flow.advance({ next: true });
    await flow.tap("op-4471", "SUPPLIER_SENDS");

    await flow.tap("op-4471", "CONFIRM_CONTACT");

    const operation = await flow.data.operations.getOperation("op-4471");
    const contact = await flow.data.parties.getContact(operation.supplierId, "ctc-qingdao-1");
    expect(contact).toMatchObject({ status: "ACTIVE", confirmedBy: "IMPORTER" });
    expect(flow.harness.turns.map((turn) => turn.envelope.event.type)).toEqual(["MILESTONE", "IMPORTER_MESSAGE", "CONTACT_CONFIRMED"]);
    expect((await emailsOut(flow, "op-4471"))[0]).toMatchObject({ kind: "DOCS_REQUEST", status: "DEFERRED", contactId: "ctc-qingdao-1" });

    await flow.advance({ next: true });

    expect((await emailsOut(flow, "op-4471"))[0]).toMatchObject({ kind: "DOCS_REQUEST", status: "SENT" });
    const documents = await flow.data.documents.listDocuments("op-4471");
    expect(documents.filter((document) => document.requestedFrom === "SUPPLIER").map((document) => document.docType).sort()).toEqual(["CERTIFICATE_OF_ORIGIN", "PACKING_LIST"]);
    await flow.tap("op-4471", "CONFIRM_CONTACT").catch(() => undefined);
    expect(flow.harness.turns.filter((turn) => turn.envelope.event.type === "CONTACT_CONFIRMED")).toHaveLength(1);
  });

  it("[FL-013] SUPPLIER_SENDS on op-4472 without authorization: send_email is denied by CP-SUPPLIER-AUTH, the agent tells the importer and escalates OTHER; no email", async () => {
    const plan: Plan = { steps: [READ_OPERATION, READ_DOSSIER, EMAIL_DOCS_REQUEST, reply("REPLY", "El estudio te va a confirmar cómo seguimos con el proveedor."), escalate("OTHER", "El importador no autorizó escribirle al proveedor.")], note: "Sin autorización." };
    const flow = await open({ "4472": { MILESTONE: [DELEGATED.MILESTONE[0]], IMPORTER_MESSAGE: [plan] } });

    await delegateToSupplier(flow, "op-4472");

    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.type === "IMPORTER_MESSAGE");
    expect(turn?.calls[2]?.output).toMatchObject({ ok: false, error: { code: "POLICY_DENIED" } });
    expect(await emailsOut(flow, "op-4472")).toEqual([]);
    expect(flow.aws.sesMessages).toEqual([]);
    const denied = (await flow.data.audit.listByOperation("op-4472")).filter((row) => row.decision === "DENY");
    expect(denied.flatMap((row) => row.ruleIds ?? [])).toContain("CP-SUPPLIER-AUTH");
    expect((await flow.data.operations.listEscalations("op-4472", { status: "OPEN" })).map((escalation) => escalation.reason)).toEqual(["OTHER"]);
  });

  it("[FL-014] the importer writes another address of the supplier: propose_supplier_contact leaves it PENDING_CONFIRMATION with CONFIRM/REJECT buttons; CONFIRM_CONTACT makes it ACTIVE and the CONTACT_CONFIRMED turn writes to the new contact", async () => {
    const address = "supplier-konkan-ops@sim.legajo.demo.craftech.io";
    let sourceMessageId = "";
    const propose: Plan = { steps: [{ tool: "propose_supplier_contact", input: () => ({ email: address, sourceMessageId }) }], note: "Propuse el contacto." };
    const confirmed: Plan = {
      steps: [READ_OPERATION, READ_DOSSIER, READ_SUPPLIER, { ...EMAIL_DOCS_REQUEST, input: (context) => ({ ...(typeof EMAIL_DOCS_REQUEST.input === "function" ? EMAIL_DOCS_REQUEST.input(context) : EMAIL_DOCS_REQUEST.input), contactId: newContactId(context.calls) }) }],
      note: "Escribí al contacto nuevo.",
    };
    const flow = await open({ "4474": { IMPORTER_MESSAGE: [propose], CONTACT_CONFIRMED: [confirmed] } });
    const phone = await flow.phoneOf("imp-patagonia");

    const asked = await flow.phone(phone, { type: "text", text: `escribile a ${address}` });
    sourceMessageId = asked.summary.records[0]?.messages[0]?.messageId ?? "";
    await flow.choose("imp-patagonia", "4474");

    const pending = (await flow.data.parties.listContacts("sup-konkan")).find((contact) => contact.email === address);
    expect(pending?.status).toBe("PENDING_CONFIRMATION");
    const offer = (await flow.messages("op-4474")).find((message) => message.kind === "CONTACT_CONFIRMATION");
    expect(offer?.buttons.map((button) => button.action)).toEqual(["CONFIRM_CONTACT", "REJECT_CONTACT"]);

    await flow.tap("op-4474", "CONFIRM_CONTACT");

    const active = (await flow.data.parties.listContacts("sup-konkan")).find((contact) => contact.email === address);
    expect(active).toMatchObject({ status: "ACTIVE", confirmedBy: "IMPORTER" });
    expect(flow.harness.turns.map((turn) => turn.envelope.event.type)).toContain("CONTACT_CONFIRMED");
    const [request] = await emailsOut(flow, "op-4474");
    expect(request).toMatchObject({ kind: "DOCS_REQUEST", to: address });
  });

  it("[FL-015] a proposed address outside the recipient fence is refused: RECIPIENT_NOT_ALLOWED, no contact, DENY CP-RECIPIENT-FENCE and an OTHER escalation", async () => {
    let sourceMessageId = "";
    const plan: Plan = { steps: [{ tool: "propose_supplier_contact", input: () => ({ email: "compras@example.com", sourceMessageId }) }, reply("REPLY", "El estudio va a revisar esa dirección."), escalate("OTHER", "El importador pasó una dirección que no podemos usar.")], note: "Dirección fuera del cerco." };
    const flow = await open({ "4474": { IMPORTER_MESSAGE: [plan] } });
    const contactsBefore = await flow.data.parties.listContacts("sup-konkan");

    const asked = await flow.phone(await flow.phoneOf("imp-patagonia"), { type: "text", text: "escribile a compras@example.com" });
    sourceMessageId = asked.summary.records[0]?.messages[0]?.messageId ?? "";
    await flow.choose("imp-patagonia", "4474");

    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.type === "IMPORTER_MESSAGE");
    expect(turn?.calls[0]?.output).toMatchObject({ ok: false, error: { code: "RECIPIENT_NOT_ALLOWED" } });
    expect(await flow.data.parties.listContacts("sup-konkan")).toEqual(contactsBefore);
    const denied = (await flow.data.audit.listByOperation("op-4474")).filter((row) => row.decision === "DENY");
    expect(denied.flatMap((row) => row.ruleIds ?? [])).toContain("CP-RECIPIENT-FENCE");
    expect((await flow.data.operations.listEscalations("op-4474", { status: "OPEN" })).map((escalation) => escalation.reason)).toEqual(["OTHER"]);
  });

  it("[FL-021] the ACTIVE contact's trusted reply with the missing certificate: intake VALID, the SUPPLIER_EMAIL turn asks for approval (READY_FOR_REVIEW) and tells the importer", async () => {
    const complete: Plan = { steps: [READ_DOSSIER, { tool: "request_approval", input: { summary: "Los tres documentos están válidos." } }, reply("REPLY", "Llegaron los documentos del proveedor; el estudio los revisa.")], note: "Legajo completo." };
    const flow = await open({ "4486": { ...DELEGATED, SUPPLIER_EMAIL: [complete] } });

    await delegateToSupplier(flow, "op-4486");
    await untilSupplierWrites(flow, "op-4486");

    const inbound = (await flow.messages("op-4486")).filter((message) => message.direction === "IN" && message.channel === "EMAIL");
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ trusted: true, counterpart: "SUPPLIER" });
    expect((await flow.data.documents.listDocuments("op-4486")).map((document) => [document.docType, document.status])).toEqual(expect.arrayContaining([["COMMERCIAL_INVOICE", "VALID"], ["PACKING_LIST", "VALID"], ["CERTIFICATE_OF_ORIGIN", "VALID"]]));
    expect((await flow.data.operations.getOperation("op-4486")).dossierStatus).toBe("READY_FOR_REVIEW");
    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.type === "SUPPLIER_EMAIL");
    expect(turn?.calls[1]?.output).toMatchObject({ ok: true });
    expect((await flow.messages("op-4486")).some((message) => message.kind === "REPLY" && message.body.startsWith("Llegaron los documentos"))).toBe(true);
  });

  it("[FL-025] WRONG_DOC: the reader recognizes another document than the one asked; it is filed under its real type, the asked one stays MISSING and the agent reminds the supplier what is missing", async () => {
    const flow = await open({ "4476": { ...DELEGATED, SUPPLIER_EMAIL: [{ steps: [READ_OPERATION, READ_DOSSIER, EMAIL_REMINDER], note: "Recordé lo que falta." }] } });
    const missingBefore = (await flow.data.documents.listDocuments("op-4476")).filter((document) => document.status === "MISSING").map((document) => document.docType);

    await delegateToSupplier(flow, "op-4476");
    await untilSupplierWrites(flow, "op-4476");

    const documents = await flow.data.documents.listDocuments("op-4476");
    for (const docType of missingBefore) {
      expect(documents.find((document) => document.docType === docType)?.status).toBe("MISSING");
      expect(await flow.data.documents.listVersions("op-4476", docType)).toEqual([]);
    }
    const [mail] = (await flow.messages("op-4476")).filter((message) => message.direction === "IN" && message.channel === "EMAIL");
    expect(mail?.attachments.map((attachment) => attachment.status)).toEqual(["ACCEPTED"]);
    // The reader recognized the invoice the supplier sent again: the same bytes as the current version, so it is a duplicate of it.
    const invoice = await flow.data.documents.listVersions("op-4476", "COMMERCIAL_INVOICE");
    expect(invoice).toHaveLength(1);
    expect(documents.find((document) => document.docType === "COMMERCIAL_INVOICE")?.status).toBe("VALID");
    const reminders = (await emailsOut(flow, "op-4476")).filter((message) => message.kind === "REMINDER");
    expect(reminders).toHaveLength(1);
  });

  it("[FL-026] UNKNOWN_DOC: the reading is UNRECOGNIZED, the PDF goes to unrecognized/, an UNRECOGNIZED_DOCUMENT escalation opens and no document changes status; the agent tells the supplier the firm reviews it", async () => {
    const flow = await open({ "4477": { ...DELEGATED, SUPPLIER_EMAIL: [{ steps: [READ_OPERATION, READ_DOSSIER, supplierEmail("REPLY", (context) => `Hello,\n\nThank you for your message about invoice ${field(context.calls, "get_operation", "operation", "invoiceNumber")}. The customs broker will review the attached file.\n\nRegards.`)], note: "El estudio revisa el PDF." }] } });
    const before = (await flow.data.documents.listDocuments("op-4477")).map((document) => [document.docType, document.status]);

    await delegateToSupplier(flow, "op-4477");
    await untilSupplierWrites(flow, "op-4477");

    expect((await flow.data.documents.listDocuments("op-4477")).map((document) => [document.docType, document.status])).toEqual(before);
    expect((await flow.data.operations.listEscalations("op-4477", { status: "OPEN" })).map((escalation) => escalation.reason)).toContain("UNRECOGNIZED_DOCUMENT");
    expect(flow.aws.objects.keys(flow.reader.documentsBucket).some((key) => key.includes("unrecognized/"))).toBe(true);
    expect((await emailsOut(flow, "op-4477")).filter((message) => message.kind === "REPLY")).toHaveLength(1);
  });

  it("[FL-027] PROMISE without attachments: the agent schedules a FOLLOWUP_DUE on the next business day 10:00 supplier time; when the documents arrived before it, its firing sends no reminder", async () => {
    const promised: Plan = {
      steps: [READ_SUPPLIER, { tool: "schedule_followup", input: { party: "SUPPLIER", atSim: "2026-10-16T10:00:00+02:00", reason: "PROMISED_BY_SUPPLIER" } }],
      note: "El proveedor prometió enviarlo.",
    };
    const flow = await open({ "4480": { ...DELEGATED, SUPPLIER_EMAIL: [promised] } });

    await delegateToSupplier(flow, "op-4480");
    await untilSupplierWrites(flow, "op-4480");

    const [promise] = (await flow.messages("op-4480")).filter((message) => message.direction === "IN" && message.channel === "EMAIL");
    expect(promise?.attachments ?? []).toEqual([]);
    const followups = await flow.data.timers.listTimers("op-4480", { kind: "FOLLOWUP_DUE" });
    expect(followups).toHaveLength(1);
    expect(followups[0]).toMatchObject({ status: "SCHEDULED", reason: "PROMISED_BY_SUPPLIER" });
    expect(Date.parse(followups[0]?.dueAtSim ?? "")).toBe(Date.parse("2026-10-16T10:00:00+02:00"));
  });

  it("[FL-028] NEVER supplier (op-4478): FOLLOWUP_FINAL sends one REMINDER in the thread; a second reminder the same day is held by CP-ONE-PER-DAY until the next business day", async () => {
    const followupFinal: Plan = { steps: [READ_OPERATION, READ_DOSSIER, EMAIL_REMINDER, EMAIL_REMINDER], note: "Recordatorio final." };
    const flow = await open({ "4478": { MILESTONE: [followupFinal] } });

    await flow.advance({ to: "2026-10-16T10:00:00-03:00" });

    const turn = flow.harness.turns.find((candidate) => candidate.envelope.event.operation === "4478");
    expect(turn?.calls[2]?.output).toMatchObject({ ok: true, status: "SENT" });
    expect(turn?.calls[3]?.output).toMatchObject({ ok: true, status: "DEFERRED", policyResult: { ruleIds: ["CP-ONE-PER-DAY"], nextAllowedAt: "2026-10-19T09:00:00+02:00" } });
    const reminders = (await emailsOut(flow, "op-4478")).filter((message) => message.kind === "REMINDER");
    expect(reminders.map((message) => message.status)).toEqual(["DELIVERED", "SENT", "DEFERRED"]);
    expect(flow.aws.sesMessages.filter((sent) => sent.input.Destination?.ToAddresses?.includes("supplier-ligurmare@sim.legajo.demo.craftech.io"))).toHaveLength(1);
    expect(header(flow, 0, "In-Reply-To")).toBeDefined();
  });

  it("[FL-028] the contact keeps lastReminderAt of its last REMINDER that went out; the deferred one does not move it", async () => {
    const followupFinal: Plan = { steps: [READ_OPERATION, READ_DOSSIER, EMAIL_REMINDER, EMAIL_REMINDER], note: "Recordatorio final." };
    const flow = await open({ "4478": { MILESTONE: [followupFinal] } });

    await flow.advance({ to: "2026-10-16T10:00:00-03:00" });

    const sent = (await emailsOut(flow, "op-4478")).filter((message) => message.kind === "REMINDER" && message.status === "SENT");
    expect(sent).toHaveLength(1);
    const operation = await flow.data.operations.getOperation("op-4478");
    const contact = (await flow.data.parties.listContacts(operation.supplierId)).find((candidate) => candidate.contactId === sent[0]?.contactId);
    expect(Date.parse(contact?.lastReminderAt ?? "")).toBe(Date.parse(sent[0]?.sentAtSim ?? ""));
  });

  it("[FL-028] LATE supplier (op-4475): the reply arrives 30 simulated hours later and is read like any other, with no second request in between", async () => {
    const flow = await open({ "4475": { ...DELEGATED, SUPPLIER_EMAIL: [{ steps: [READ_DOSSIER], note: "Leí la respuesta." }] } });

    await delegateToSupplier(flow, "op-4475");
    const [request] = await emailsOut(flow, "op-4475");
    await untilSupplierWrites(flow, "op-4475", 1, 12);

    const [late] = (await flow.messages("op-4475")).filter((message) => message.direction === "IN" && message.channel === "EMAIL");
    expect(Date.parse(late?.sentAtSim ?? "") - Date.parse(request?.sentAtSim ?? "")).toBeGreaterThanOrEqual(30 * 3_600_000);
    expect((await emailsOut(flow, "op-4475")).filter((message) => message.kind === "DOCS_REQUEST")).toHaveLength(1);
    expect(flow.harness.turns.some((turn) => turn.envelope.event.type === "SUPPLIER_EMAIL" && turn.envelope.event.operation === "4475")).toBe(true);
  });

  it("[FL-029] SES Bounce Permanent of the op-4474 contact: the email is BOUNCED, the contact BOUNCED and the EMAIL_BOUNCED turn asks the importer for another contact with legajo_contacto_proveedor", async () => {
    const bounced: Plan = {
      steps: [READ_OPERATION, READ_SUPPLIER, { tool: "send_whatsapp", input: (context) => ({ recipientRole: "IMPORTER", kind: "CONTACT_REQUEST", template: { name: "legajo_contacto_proveedor", params: [field(context.calls, "get_operation", "operation", "operationNumber"), (outputOf(context.calls, "get_operation").operation as { supplier: { name: string } }).supplier.name] } }) }],
      note: "Pedí otro contacto.",
    };
    const flow = await open({ "4474": { ...DELEGATED, EMAIL_BOUNCED: [bounced] } });
    await delegateToSupplier(flow, "op-4474");
    for (let move = 0; move < 3 && flow.aws.sesMessages.length === 0; move += 1) await flow.advance({ next: true });
    const sent = flow.aws.sesMessages.find((candidate) => candidate.input.Destination?.ToAddresses?.includes("bounce@simulator.amazonses.com"));
    expect(sent).toBeDefined();

    await flow.entries.channelEvent(sesEventOf(sent as NonNullable<typeof sent>, "Bounce", flow.realNow()));
    await flow.entries.settle();

    expect((await emailsOut(flow, "op-4474"))[0]?.status).toBe("BOUNCED");
    expect((await flow.data.parties.listContacts("sup-konkan")).find((contact) => contact.contactId === "ctc-konkan-1")?.status).toBe("BOUNCED");
    expect(flow.harness.turns.map((turn) => turn.envelope.event.type)).toContain("EMAIL_BOUNCED");
    const request = (await flow.messages("op-4474")).find((message) => message.kind === "CONTACT_REQUEST");
    expect(request?.template?.name).toBe("legajo_contacto_proveedor");
    expect(await flow.data.timers.listTimers("op-4474", { kind: "CONTACT_CHECK" })).toHaveLength(1);
  });
});

/** The ACTIVE contact `get_counterpart_profile(SUPPLIER)` lists in the simulated domain (the one the importer just gave). */
function newContactId(calls: Parameters<typeof outputOf>[0]): string {
  const supplier = outputOf(calls, "get_counterpart_profile").supplier as { contacts: Array<{ contactId: string; status: string; emailMasked: string }> };
  return supplier.contacts.find((contact) => contact.status === "ACTIVE" && contact.emailMasked.endsWith("@sim.legajo.demo.craftech.io"))?.contactId ?? "";
}

