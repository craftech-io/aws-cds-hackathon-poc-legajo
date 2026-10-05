import { describe, expect, it } from "vitest";
import { importerFixture } from "../../connector/testing";
import { deriveSubkey, phoneHash } from "../../lib/crypto";
import { processWhatsAppEvent } from "./inbound";
import { deriveNonce, issueNonces } from "./nonces";
import { KEYS, OTHER_PHONE, REAL_NOW, type WaWorld, addOperation, sentWithButtons, simEvent, waWorld } from "./testing";

async function denials(world: WaWorld, operationId: string): Promise<string[]> {
  return (await world.stores.connector.audit.listByOperation(operationId)).filter((decision) => decision.decision === "DENY").map((decision) => decision.action);
}

async function tap(world: WaWorld, nonce: string, options: { readonly wamid?: string; readonly contextWamid?: string } = {}) {
  const summary = await processWhatsAppEvent(simEvent({ type: "template_reply", nonce, title: "Los manda el proveedor" }, { wamid: options.wamid ?? "wamid.SIM.TAP01", ...(options.contextWamid === undefined ? {} : { contextWamid: options.contextWamid }) }), world.deps);
  return summary.records[0]?.messages[0];
}

/** What the refused tap became: free text of the importer, with the button marked as not resolved. */
async function readAsText(world: WaWorld) {
  const [message] = await world.stores.connector.conversations.listMessages("op-4471", { direction: "IN" });
  expect(message).toMatchObject({ body: "Los manda el proveedor", interactive: { buttonAction: "SUPPLIER_SENDS", buttonResolved: false } });
  expect(world.events).toMatchObject([{ type: "AGENT_TURN", operationId: "op-4471", messageId: message?.messageId }]);
}

describe("[FL-095] a foreign or expired nonce does nothing", () => {
  it("[FL-095] a nonce issued to another importer's phone is refused and audited on its operation; its title is free text", async () => {
    const world = await waWorld();
    await world.stores.connector.parties.createImporter(importerFixture({ importerId: "imp-patagonia", name: "Patagonia Frío SA", phoneE164: OTHER_PHONE, phoneHash: phoneHash(KEYS.phoneHash, OTHER_PHONE) }));
    await addOperation(world.stores, { operationNumber: "4474", importerId: "imp-patagonia" });
    const foreign = await sentWithButtons(world, [{ action: "SUPPLIER_SENDS" }], { operationId: "op-4474", template: true });
    expect((await tap(world, foreign.nonces[0] ?? ""))?.outcome).toBe("TURN");
    expect(await denials(world, "op-4474")).toEqual(["NONCE_FOREIGN"]);
    await readAsText(world);
    expect(world.contacts).toEqual([]);
  });

  it("[FL-095] an expired nonce is refused and audited; its title is free text", async () => {
    const world = await waWorld();
    const sent = await sentWithButtons(world, [{ action: "SUPPLIER_SENDS" }], { template: true });
    world.setNow(new Date(Date.parse(REAL_NOW) + 7 * 24 * 3_600_000 + 1_000).toISOString());
    await tap(world, sent.nonces[0] ?? "");
    expect(await denials(world, "op-4471")).toEqual(["NONCE_EXPIRED"]);
    await readAsText(world);
  });

  it("[FL-095] a nonce that is not of the message the importer replies to, or no nonce at all, is refused", async () => {
    const world = await waWorld();
    const sent = await sentWithButtons(world, [{ action: "SUPPLIER_SENDS" }], { template: true });
    const other = await sentWithButtons(world, [{ action: "QUESTION" }], { wamid: "wamid.SIM.OUT-OTHER" });
    await tap(world, sent.nonces[0] ?? "", { contextWamid: other.wamid });
    await tap(world, "NoSuchNonce0000000000000000000000", { wamid: "wamid.SIM.TAP02" });
    expect(await denials(world, "op-4471")).toEqual(["NONCE_OTHER_OPERATION", "NONCE_UNKNOWN"]);
    const taps = await world.stores.connector.conversations.listMessages("op-4471", { direction: "IN" });
    // An unknown nonce does not even say which button it was.
    expect(taps.map((message) => message.interactive?.buttonResolved)).toEqual([false, undefined]);
    expect(world.events.map((event) => event.type)).toEqual(["AGENT_TURN", "AGENT_TURN"]);
  });

  it("[FL-095] a reply that quotes a message the stage does not know (a live send, stored under its AWS id) resolves on the nonce alone", async () => {
    const world = await waWorld();
    const sent = await sentWithButtons(world, [{ action: "SUPPLIER_SENDS" }], { template: true });
    await tap(world, sent.nonces[0] ?? "", { contextWamid: "wamid.HBgNNTQ5MTEzMjEwMzU2MhUCABEYEkIxQkI1MTA0RkUyMEQ0OEIyAA==" });
    expect(await denials(world, "op-4471")).toEqual([]);
    expect(world.events).toMatchObject([{ type: "AGENT_TURN", operationId: "op-4471" }]);
  });

  it("[FL-095] the same nonce from its own importer and message still resolves", async () => {
    const world = await waWorld();
    const sent = await sentWithButtons(world, [{ action: "SUPPLIER_SENDS" }], { template: true });
    await tap(world, sent.nonces[0] ?? "", { contextWamid: sent.wamid });
    expect(await denials(world, "op-4471")).toEqual([]);
    expect(world.events).toMatchObject([{ type: "AGENT_TURN", operationId: "op-4471" }]);
    expect((await world.stores.connector.conversations.listMessages("op-4471", { direction: "IN" }))[0]?.interactive).toMatchObject({ buttonAction: "SUPPLIER_SENDS", buttonResolved: true });
  });
});

describe("issuing nonces", () => {
  it("derives each nonce from the message, the position and the nonce subkey; reissuing writes the same ones", async () => {
    const world = await waWorld();
    const input = { nonceKey: KEYS.nonce, messageId: "msg-0a1b2c3d", operationId: "op-4471", importerId: "imp-norpampa", phoneHash: phoneHash(KEYS.phoneHash, "+5491155500101"), clockId: "GLOBAL#firm-delta", buttons: [{ action: "QUESTION" as const }, { action: "TALK_TO_FIRM" as const }], now: new Date(REAL_NOW) };
    const first = await issueNonces(world.stores.connector.runtime, input);
    expect(await issueNonces(world.stores.connector.runtime, input)).toEqual(first);
    expect(first).toEqual([deriveNonce(KEYS.nonce, "msg-0a1b2c3d", 0, "QUESTION"), deriveNonce(KEYS.nonce, "msg-0a1b2c3d", 1, "TALK_TO_FIRM")]);
    expect(new Set(first).size).toBe(2);
    expect(deriveNonce(deriveSubkey("another-master-key-00000000000000000000000", "nonce"), "msg-0a1b2c3d", 0, "QUESTION")).not.toBe(first[0]);
    expect(await world.stores.connector.runtime.getNonce(first[0] ?? "")).toMatchObject({ action: "QUESTION", messageId: "msg-0a1b2c3d", expiresAt: Math.floor(Date.parse(REAL_NOW) / 1000) + 7 * 24 * 3_600 });
  });

  it("refuses a contact button without the contact it asks about", async () => {
    const world = await waWorld();
    await expect(
      issueNonces(world.stores.connector.runtime, { nonceKey: KEYS.nonce, messageId: "msg-0a1b2c3e", operationId: "op-4471", importerId: "imp-norpampa", phoneHash: "0".repeat(64), clockId: "GLOBAL#firm-delta", buttons: [{ action: "CONFIRM_CONTACT" }], now: new Date(REAL_NOW) }),
    ).rejects.toThrow(RangeError);
  });
});
