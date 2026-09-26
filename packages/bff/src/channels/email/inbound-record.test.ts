import { beforeEach, describe, expect, it } from "vitest";
import { receiveInboundEmail } from "./inbound";
import { inboundMessageId, isAutomaticMail } from "./inbound-record";
import { parseMime } from "./mime";
import { type EmailWorld, QINGDAO, deliver, emailWorld, fixture, inboundDeps, mime, receiptEvent } from "./testing";

let world: EmailWorld;

beforeEach(async () => {
  world = await emailWorld();
});

async function receive(sesMessageId: string, raw: Uint8Array, rfcMessageId: string) {
  deliver(world, sesMessageId, raw);
  return receiveInboundEmail(receiptEvent({ sesMessageId, recipient: world.op4471.threadAddress, rfcMessageId }), inboundDeps(world));
}

describe("what a trusted email becomes", () => {
  it("caps the stored body at 4,000 characters, audits the cut and masks what it keeps", async () => {
    const text = `Invoice QBT-2026-0917, CUIT 30-71234567-9. ${"The packing list is attached. ".repeat(200)}`;
    await receive("ses-long", mime({ from: QINGDAO, messageId: "<long@sim.legajo.demo.craftech.io>", text }), "<long@sim.legajo.demo.craftech.io>");
    const [message] = await world.stores.connector.conversations.listMessages("op-4471");
    expect(message?.truncated).toBe(true);
    expect([...(message?.body ?? "")].length).toBeLessThanOrEqual(4_000);
    expect(message?.body).toContain("CUIT [CUIT]");
    const actions = (await world.stores.connector.audit.listByOperation("op-4471")).map((row) => row.action);
    expect(actions).toEqual(["INBOUND_TRUNCATED"]);
  });

  it("sends five PDFs to intake and records the sixth as rejected", async () => {
    await receive("ses-many", mime({ from: QINGDAO, messageId: "<many@sim.legajo.demo.craftech.io>", pdfs: 6 }), "<many@sim.legajo.demo.craftech.io>");
    expect(world.sink.events.map((event) => event.type)).toEqual(["INTAKE_DOCUMENT", "INTAKE_DOCUMENT", "INTAKE_DOCUMENT", "INTAKE_DOCUMENT", "INTAKE_DOCUMENT", "AGENT_TURN"]);
    const [message] = await world.stores.connector.conversations.listMessages("op-4471");
    expect(message?.attachments.map((attachment) => attachment.status)).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED", "REJECTED"]);
    expect(message?.attachments[5]?.reason).toBe("TOO_MANY");
  });

  it("keeps a masked subject and the file names on the record, never a new object key from them", async () => {
    await receive("ses-names", fixture("reply.eml"), "<reply-4471-1@sim.legajo.demo.craftech.io>");
    const [message] = await world.stores.connector.conversations.listMessages("op-4471");
    expect(message?.subject).toBe("Re: [Op 4471] Missing documents: packing list, certificate of origin (Invoice QBT-2026-0917)");
    expect(message?.attachments.map((attachment) => attachment.filename)).toEqual(["packing-list-QBT-2026-0917.pdf", "certificate-of-origin-QBT-2026-0917.pdf", "logo.png"]);
    for (const event of world.sink.events) if (event.type === "INTAKE_DOCUMENT") expect(event.object.key).toBe("poc/ops/ses-names");
  });

  it("does not link a reply to an outbound message of another operation", async () => {
    await world.stores.connector.conversations.appendMessage({
      messageId: "msg-4483out1",
      operationId: world.op4483.operationId,
      firmId: "firm-delta",
      clockId: world.op4483.clockId,
      direction: "OUT",
      channel: "EMAIL",
      counterpart: "SUPPLIER",
      to: "supplier-santosverde@sim.legajo.demo.craftech.io",
      from: world.op4483.threadAddress,
      body: "Hello.",
      status: "SENT",
      author: "AGENT",
      sentAtSim: "2026-10-15T12:00:00.000Z",
      sentAtReal: "2026-09-26T15:00:00.000Z",
      providerMessageId: "0100019a2b3c4d5e-6f708192-a3b4-45c6-97d8-e9fa0b1c2d3e-000000",
    });
    await receive("ses-cross-thread", fixture("reply.eml"), "<reply-4471-1@sim.legajo.demo.craftech.io>");
    const turn = world.sink.events.find((event) => event.type === "AGENT_TURN");
    expect(turn?.type === "AGENT_TURN" ? turn.inReplyToMessageId : "linked").toBeUndefined();
  });

  it("derives the stored message id from SES's id", () => {
    expect(inboundMessageId("abc")).toMatch(/^msg-[0-9a-f]{24}$/);
    expect(inboundMessageId("abc")).toBe(inboundMessageId("abc"));
    expect(inboundMessageId("abd")).not.toBe(inboundMessageId("abc"));
  });

  it("treats a human reply as a human one", async () => {
    const mail = await parseMime(fixture("reply.eml"));
    expect(isAutomaticMail(mail, mail.from)).toBe(false);
    expect(isAutomaticMail(await parseMime(fixture("auto-reply.eml")), "supplier-ningbo@sim.legajo.demo.craftech.io")).toBe(true);
  });
});
