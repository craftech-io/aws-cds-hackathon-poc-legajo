// [W5-OUT-EFFECTS-AFTER-SEND] The marks a sent message leaves in the dossier (effects.ts) are best
// effort: the transport already took the message, so a CONFLICT with another writer (DocumentIntake,
// ChannelEvents) is retried from a fresh read, and whatever still fails is logged and counted while the
// send stays SENT. A send that reached the party never comes back as an error, so nothing invites a
// second one.
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ConnectorError } from "@legajo/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySentEffects } from "./effects";
import { sendOutbound } from "./pipeline";
import { DOSSIER, EMAIL_TEXT, FRI_10_QINGDAO, outboundWorld, supplierEmail, type OutboundWorld } from "./testing";

let world: OutboundWorld;

beforeEach(async () => {
  world = await outboundWorld();
});

const conflict = (): ConnectorError => new ConnectorError("CONFLICT", "document changed", "Documents");

function failureLines(): Record<string, unknown>[] {
  return world.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.metric === "OutboundEffectFailed");
}

async function sendToSupplier(): Promise<Awaited<ReturnType<typeof sendOutbound>>> {
  const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "CONTACT_CONFIRMED");
  return sendOutbound(world.deps, supplierEmail(turnId, FRI_10_QINGDAO, EMAIL_TEXT), world.call());
}

describe("[W5-OUT-EFFECTS-AFTER-SEND] a send that went out", () => {
  it("stays SENT when updateDocument keeps answering CONFLICT, with the failure logged and counted", async () => {
    const update = vi.spyOn(world.deps.data.documents, "updateDocument").mockRejectedValue(conflict());
    const result = await sendToSupplier();
    expect(result).toMatchObject({ status: "SENT", providerMessageId: "0100019a-ses-000001" });
    if (result.status !== "SENT") throw new Error("expected SENT");
    expect(await world.stores.connector.conversations.getMessage("op-4471", result.messageId)).toMatchObject({ status: "SENT" });
    expect(world.ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(3);
    expect(failureLines()).toEqual([expect.objectContaining({ effect: "requested", kind: "DOCS_REQUEST" })]);
  });

  it("retries a CONFLICT from a fresh read and leaves its marks", async () => {
    const documents = world.deps.data.documents;
    const real = documents.updateDocument.bind(documents);
    vi.spyOn(documents, "updateDocument").mockRejectedValueOnce(conflict()).mockImplementation(real);
    expect(await sendToSupplier()).toMatchObject({ status: "SENT" });
    for (const docType of ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] as const) {
      expect(await documents.getDocument("op-4471", docType)).toMatchObject({ requestedFrom: "SUPPLIER", lastRequestedAtSim: expect.any(String) });
    }
    expect(failureLines()).toEqual([]);
  });

  it("never throws: a reminder whose contact write fails still lets the other marks through", async () => {
    const send = supplierEmail("turn-T0001", FRI_10_QINGDAO, EMAIL_TEXT);
    const reminder = vi.spyOn(world.deps.data.parties, "markContactReminder").mockRejectedValue(new Error("down"));
    const context = { operation: { operationId: "op-4471" }, contact: { supplierId: "sup-qingdao", contactId: "ctc-qingdao-1" } } as unknown as Parameters<typeof applySentEffects>[1]["context"];
    await expect(applySentEffects(world.deps, { request: { ...send, kind: "REMINDER" }, context, sentAtSim: FRI_10_QINGDAO, actor: "AGENT", messageId: "msg-x", log: world.call().log })).resolves.toBeUndefined();
    expect(reminder).toHaveBeenCalledTimes(1);
    expect(await world.deps.data.documents.getDocument("op-4471", "PACKING_LIST")).toMatchObject({ requestedFrom: "SUPPLIER" });
    expect(failureLines()).toEqual([expect.objectContaining({ effect: "reminder", kind: "REMINDER" })]);
  });
});
