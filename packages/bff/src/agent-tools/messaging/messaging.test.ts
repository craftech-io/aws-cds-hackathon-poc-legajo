// The `messaging` target through the Gateway (docs/tool-catalog.md; FL-007, FL-013): the wrapper's
// guards, then the outbound pipeline, and the answers the model reads (SENT, DEFERRED with the instant
// already formatted, or the refusal of the rule that stopped the send).
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { beforeEach, describe, expect, it } from "vitest";
import { FRI_10_QINGDAO, THU_10_AR } from "../../outbound/testing";
import { DOSSIER, messagingWorld, type MessagingWorld } from "./testing";

let world: MessagingWorld;

beforeEach(async () => {
  world = await messagingWorld();
});

const TEMPLATE = { name: "legajo_docs_pendientes", params: ["Estudio Delta", "4471", "Austral Aurora", "22/10", "certificado de origen y packing list"] };
const EMAIL = "Hello, for invoice QBT-2026-0917 we still need the packing list and the certificate of origin. Please send them by October 19, 10:00 (Asia/Shanghai). Thank you.";

describe("[FL-007] send_whatsapp in a milestone turn", () => {
  it("sends the template outside the window and answers what went out", async () => {
    const { token, turnId } = await world.open("MILESTONE", THU_10_AR, [{ tool: "get_dossier", output: DOSSIER }]);
    const answer = await world.gateway("send_whatsapp", { sessionToken: token, recipientRole: "IMPORTER", kind: "DOCS_REQUEST", template: TEMPLATE, refs: { docTypes: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] } });
    expect(answer).toMatchObject({ ok: true, status: "SENT", templateUsed: "legajo_docs_pendientes", windowState: "TEMPLATE_REQUIRED", policyResult: { allowed: true } });
    const messageId = (answer as unknown as { messageId: string }).messageId;
    expect(await world.stores.connector.conversations.getMessage("op-4471", messageId)).toMatchObject({ kind: "DOCS_REQUEST", template: { name: "legajo_docs_pendientes" }, author: "AGENT", turnId });
    expect((await world.stores.connector.runtime.listTurnResults(turnId)).map((result) => result.tool)).toEqual(["get_dossier", "send_whatsapp"]);
  });

  it("a reminder outside a milestone or follow-up turn is FORBIDDEN before anything is decided", async () => {
    const { token } = await world.open("IMPORTER_MESSAGE", THU_10_AR, [{ tool: "get_dossier", output: DOSSIER }]);
    const answer = await world.gateway("send_whatsapp", { sessionToken: token, recipientRole: "IMPORTER", kind: "REMINDER", template: { name: "legajo_recordatorio", params: ["4471", "packing list", "19/10 10:00"] } });
    expect(answer).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "TRIGGER_NOT_ALLOWED" } });
    expect(world.g2.calls).toEqual([]);
  });

  it("the model never writes a contact button: those carry what only the code knows", async () => {
    await world.inbound("¿Le escribo yo?", "2026-10-15T09:30:00-03:00");
    const { token } = await world.open("IMPORTER_MESSAGE", THU_10_AR, [{ tool: "get_dossier", output: DOSSIER }]);
    const answer = await world.gateway("send_whatsapp", { sessionToken: token, recipientRole: "IMPORTER", kind: "REPLY", text: "¿Le escribimos?", buttons: [{ action: "CONFIRM_CONTACT" }] });
    expect(answer).toMatchObject({ ok: false, error: { code: "INVALID", reason: "RESERVED_BUTTON" } });
  });

  it("the recipient never comes from the input", async () => {
    const { token } = await world.open("MILESTONE", THU_10_AR, [{ tool: "get_dossier", output: DOSSIER }]);
    const answer = await world.gateway("send_whatsapp", { sessionToken: token, recipientRole: "IMPORTER", kind: "DOCS_REQUEST", template: TEMPLATE, to: "+5491155500102" });
    expect(answer).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });
});

describe("[FL-013] send_email without the importer's authorization", () => {
  it("is POLICY_DENIED under CP-SUPPLIER-AUTH, audited, and no email leaves; the reply to the importer still goes", async () => {
    await world.stores.connector.parties.setAuthorization({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: false, atSim: "2026-10-01T10:00:00-03:00", by: "BROKER:brk-ana" });
    await world.inbound("Los manda el proveedor", "2026-10-15T09:55:00-03:00");
    const { token } = await world.open("IMPORTER_MESSAGE", THU_10_AR, [{ tool: "get_dossier", output: DOSSIER }]);
    const denied = await world.gateway("send_email", { sessionToken: token, recipientRole: "SUPPLIER", kind: "DOCS_REQUEST", text: EMAIL, refs: { docTypes: ["PACKING_LIST"] } });
    expect(denied).toMatchObject({ ok: false, error: { code: "POLICY_DENIED", reason: "CP-SUPPLIER-AUTH" } });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect((await world.stores.connector.audit.listByOperation("op-4471")).at(-1)).toMatchObject({ decision: "DENY", action: "SEND_EMAIL", ruleIds: ["CP-SUPPLIER-AUTH"], actor: "AGENT" });
    const reply = await world.gateway("send_whatsapp", { sessionToken: token, recipientRole: "IMPORTER", kind: "REPLY", text: "El estudio te va a confirmar cómo seguimos con el proveedor de la operación 4471." });
    expect(reply).toMatchObject({ ok: true, status: "SENT", windowState: "OPEN" });
  });
});

describe("send_email to the supplier", () => {
  it("defers outside the supplier's hours and answers the instant in the supplier's zone", async () => {
    const { token } = await world.open("CONTACT_CONFIRMED", THU_10_AR, [{ tool: "get_dossier", output: DOSSIER }]);
    const answer = await world.gateway("send_email", { sessionToken: token, recipientRole: "SUPPLIER", kind: "DOCS_REQUEST", text: EMAIL, refs: { docTypes: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] } });
    expect(answer).toMatchObject({ ok: true, status: "DEFERRED", deferredUntilText: "16/10 09:00 Asia/Shanghai", policyResult: { allowed: false, ruleIds: ["CP-HOURS-SUPPLIER"], nextAllowedAt: "2026-10-16T09:00:00+08:00" } });
  });

  it("sends inside them, to the ACTIVE contact, and a contact of another supplier is out of scope", async () => {
    const { token } = await world.open("CONTACT_CONFIRMED", FRI_10_QINGDAO, [{ tool: "get_dossier", output: DOSSIER }]);
    expect(await world.gateway("send_email", { sessionToken: token, recipientRole: "SUPPLIER", kind: "DOCS_REQUEST", text: EMAIL, refs: { docTypes: ["PACKING_LIST"] } })).toMatchObject({ ok: true, status: "SENT", guardrail: { action: "NONE" } });
    expect(await world.gateway("send_email", { sessionToken: token, recipientRole: "SUPPLIER", kind: "DOCS_REQUEST", contactId: "ctc-santosverde-1", text: EMAIL, refs: {} })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it("a PENDING_CONFIRMATION contact is never written to", async () => {
    const { token } = await world.open("CONTACT_CONFIRMED", FRI_10_QINGDAO, [{ tool: "get_dossier", output: DOSSIER }]);
    const answer = await world.gateway("send_email", { sessionToken: token, recipientRole: "SUPPLIER", kind: "DOCS_REQUEST", contactId: "ctc-qingdao-2", text: EMAIL, refs: {} });
    expect(answer).toMatchObject({ ok: false, error: { code: "POLICY_DENIED" } });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});

describe("a person of the firm writes from the console", () => {
  it("their text is not checked by G2, and the message is theirs", async () => {
    await world.inbound("Hola, ¿hay novedades?", "2026-10-15T09:30:00-03:00");
    await world.stores.connector.world.updateClock("GLOBAL#firm-delta", { pausedSimNow: THU_10_AR });
    const answer = await world.target.invoke("send_whatsapp", { caller: { kind: "CONSOLE", firmId: "firm-delta", brokerId: "brk-ana", role: "BROKER" }, operationId: "op-4471", recipientRole: "IMPORTER", kind: "BROKER_MESSAGE", text: "Hola Lucía, mañana te llamamos por la operación." });
    expect(answer).toMatchObject({ ok: true, status: "SENT" });
    expect(world.g2.calls).toEqual([]);
    const sent = await world.stores.connector.conversations.getMessage("op-4471", (answer as unknown as { messageId: string }).messageId);
    expect(sent).toMatchObject({ author: "BROKER:brk-ana", kind: "BROKER_MESSAGE" });
  });
});
