// `propose_supplier_contact` (docs/tool-catalog.md; FL-014, FL-015): an address the importer wrote, as
// written (`LAM-EVIDENCE`), inside the recipient fence, registered `PENDING_CONFIRMATION` with its claim,
// and the importer asked to confirm it with two buttons whose nonces carry the contact.
import { beforeEach, describe, expect, it } from "vitest";
import { THU_10_AR } from "../../outbound/testing";
import { messagingWorld, type MessagingWorld } from "./testing";

const ALT = "supplier-qingdao-ops2@sim.legajo.demo.craftech.io";

let world: MessagingWorld;

beforeEach(async () => {
  world = await messagingWorld();
});

async function propose(text: string, email: string, trigger: "IMPORTER_MESSAGE" | "MILESTONE" = "IMPORTER_MESSAGE"): Promise<{ readonly answer: Awaited<ReturnType<MessagingWorld["gateway"]>>; readonly sourceMessageId: string }> {
  const sourceMessageId = await world.inbound(text, "2026-10-15T09:50:00-03:00");
  const { token } = await world.open(trigger, THU_10_AR);
  return { answer: await world.gateway("propose_supplier_contact", { sessionToken: token, email, sourceMessageId }), sourceMessageId };
}

describe("[FL-014] the importer passes another contact of the supplier", () => {
  it("registers it PENDING_CONFIRMATION and asks the importer with CONFIRM/REJECT buttons", async () => {
    const { answer, sourceMessageId } = await propose(`Escribile a ${ALT} que es el de operaciones`, ALT);
    expect(answer).toMatchObject({ ok: true, status: "PENDING_CONFIRMATION" });
    const { contactId, confirmationMessageId } = answer as unknown as { contactId: string; confirmationMessageId: string };
    expect(await world.stores.connector.parties.findContact("sup-qingdao", contactId)).toMatchObject({ email: ALT, status: "PENDING_CONFIRMATION", sourceMessageId });
    const question = await world.stores.connector.conversations.getMessage("op-4471", confirmationMessageId);
    expect(question).toMatchObject({ kind: "CONTACT_CONFIRMATION", body: expect.stringContaining("s***@sim.legajo.demo.craftech.io") });
    expect(question?.body).not.toContain(ALT);
    expect(question?.buttons.map((button) => button.action)).toEqual(["CONFIRM_CONTACT", "REJECT_CONTACT"]);
    expect(await world.stores.connector.runtime.getNonce(question?.buttons[0]?.nonce ?? "")).toMatchObject({ payload: { supplierId: "sup-qingdao", contactId } });
    expect(await world.stores.connector.audit.listByOperation("op-4471")).toContainEqual(expect.objectContaining({ decision: "ACTION", action: "CONTACT_PROPOSED", refs: expect.objectContaining({ contactId }) }));
  });

  it("an address the importer did not write is refused under LAM-EVIDENCE", async () => {
    const { answer } = await propose("El de operaciones te va a escribir", ALT);
    expect(answer).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "ADDRESS_NOT_IN_MESSAGE" } });
    expect((await world.stores.connector.parties.listContacts("sup-qingdao")).map((contact) => contact.email)).not.toContain(ALT);
    expect((await world.stores.connector.audit.listByOperation("op-4471")).at(-1)).toMatchObject({ decision: "DENY", ruleIds: ["LAM-EVIDENCE"] });
  });

  it("the source must be the importer's message, and only an IMPORTER_MESSAGE turn may propose", async () => {
    const { token } = await world.open("IMPORTER_MESSAGE", THU_10_AR);
    expect(await world.gateway("propose_supplier_contact", { sessionToken: token, email: ALT, sourceMessageId: "msg-notamessage1" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const { answer } = await propose(`Escribile a ${ALT}`, ALT, "MILESTONE");
    expect(answer).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "TRIGGER_NOT_ALLOWED" } });
  });

  it("an address that is already a contact of the supplier is a CONFLICT", async () => {
    const { answer } = await propose("Escribile a supplier-qingdao@sim.legajo.demo.craftech.io", "supplier-qingdao@sim.legajo.demo.craftech.io");
    expect(answer).toMatchObject({ ok: false, error: { code: "CONFLICT", reason: "ALREADY_A_CONTACT" } });
  });
});

describe("[FL-015] a proposed contact outside the fence", () => {
  it("is RECIPIENT_NOT_ALLOWED, audited under CP-RECIPIENT-FENCE, and nothing is registered or sent", async () => {
    const { answer } = await propose("Escribile a compras@bluewave-mail.com", "compras@bluewave-mail.com");
    expect(answer).toMatchObject({ ok: false, error: { code: "RECIPIENT_NOT_ALLOWED" } });
    expect((await world.stores.connector.audit.listByOperation("op-4471")).at(-1)).toMatchObject({ decision: "DENY", ruleIds: ["CP-RECIPIENT-FENCE"] });
    expect((await world.stores.connector.parties.listContacts("sup-qingdao")).length).toBe(2);
    expect(await world.stores.connector.conversations.listMessages("op-4471", { direction: "OUT" })).toEqual([]);
  });

  it("a reserved domain is refused the same way", async () => {
    const { answer } = await propose("Escribile a compras@example.com", "compras@example.com");
    expect(answer).toMatchObject({ ok: false, error: { code: "RECIPIENT_NOT_ALLOWED", reason: "RESERVED_DOMAIN" } });
  });
});
