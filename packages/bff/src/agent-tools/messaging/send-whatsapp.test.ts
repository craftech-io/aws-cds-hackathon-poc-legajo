// FL-009 and docs/design-brief.md §5.7 "Acuse de una carga por link": an upload by link is not a message
// of the importer, so it opens no window. In the `UPLOAD_COMPLETED` turn the acknowledgement goes out
// only when the importer wrote in the last 24 hours; otherwise the reply is `TEMPLATE_REQUIRED` and a
// reminder is not the agent's to send in that turn (`LAM-TRIGGER`): nothing goes out by WhatsApp.
import { beforeEach, describe, expect, it } from "vitest";
import { THU_10_AR } from "../../outbound/testing";
import { DOSSIER, messagingWorld, type MessagingWorld } from "./testing";

let world: MessagingWorld;

beforeEach(async () => {
  world = await messagingWorld();
});

const RESULTS = [{ tool: "get_dossier", output: { ...DOSSIER, missingDocuments: "packing list" } }];
const ACK = "Recibimos el certificado de origen de la operación 4471; falta el packing list.";

async function outboundWhatsApps(): Promise<number> {
  return (await world.stores.connector.conversations.listMessages("op-4471", { direction: "OUT", channel: "WHATSAPP" })).length;
}

describe("[FL-009] the acknowledgement of an upload by link", () => {
  it("(a) with the window open, the reply goes out", async () => {
    await world.inbound("Ahora subo el certificado", "2026-10-15T08:00:00-03:00");
    const { token } = await world.open("UPLOAD_COMPLETED", THU_10_AR, RESULTS);
    const answer = await world.gateway("send_whatsapp", { sessionToken: token, recipientRole: "IMPORTER", kind: "REPLY", text: ACK, refs: { docTypes: ["CERTIFICATE_OF_ORIGIN"] } });
    expect(answer).toMatchObject({ ok: true, status: "SENT", windowState: "OPEN" });
    expect(await outboundWhatsApps()).toBe(1);
  });

  it("(b) with the window closed, the reply is TEMPLATE_REQUIRED and a reminder is FORBIDDEN: nothing goes out", async () => {
    await world.inbound("Hola", "2026-10-13T08:00:00-03:00");
    const { token } = await world.open("UPLOAD_COMPLETED", THU_10_AR, RESULTS);
    const reply = await world.gateway("send_whatsapp", { sessionToken: token, recipientRole: "IMPORTER", kind: "REPLY", text: ACK });
    expect(reply).toMatchObject({ ok: false, error: { code: "TEMPLATE_REQUIRED", reason: "CP-WA-24H" } });
    const reminder = await world.gateway("send_whatsapp", { sessionToken: token, recipientRole: "IMPORTER", kind: "REMINDER", template: { name: "legajo_recordatorio", params: ["4471", "packing list", "19/10 10:00"] } });
    expect(reminder).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "TRIGGER_NOT_ALLOWED" } });
    expect(await outboundWhatsApps()).toBe(0);
    expect(world.uploads).toEqual([]);
  });

  it("what the reading demands and has a template still goes out with the window closed", async () => {
    const { token } = await world.open("UPLOAD_COMPLETED", THU_10_AR, [{ tool: "read_document", output: { operationNumber: "4471", correctionTarget: "el peso bruto del packing list" } }]);
    const notice = await world.gateway("send_whatsapp", { sessionToken: token, recipientRole: "IMPORTER", kind: "NO_ACTION_NEEDED", template: { name: "legajo_observacion_proveedor", params: ["4471", "el peso bruto del packing list"] } });
    expect(notice).toMatchObject({ ok: true, status: "SENT", templateUsed: "legajo_observacion_proveedor" });
  });
});
