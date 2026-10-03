import { describe, expect, it } from "vitest";
import { turnEventId } from "../../channels/adapter";
import { CLOCK, FIRM, hashOf } from "../../connector/testing";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { type ServiceWorld, consoleCaller, serviceWorld } from "../operations-admin/testing";
import { channelServices } from "./channel-services";
import { confirmSupplierContactHandler } from "./confirm";

const PROPOSED = "ventas-qingdao@sim.legajo.demo.craftech.io";
const WAMID = "wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABIYFjNFQjBDT05GSVJNMDAwMDAwMDAwMQA=";
const AT_SIM = "2026-10-14T10:30:00-03:00";

async function proposed(world: ServiceWorld): Promise<void> {
  await world.stores.connector.parties.createContact({
    contactId: "ctc-qingdao-2",
    supplierId: "sup-qingdao",
    firmId: FIRM,
    clockId: CLOCK,
    email: PROPOSED,
    emailHash: hashOf(PROPOSED),
    status: "PENDING_CONFIRMATION",
    sourceMessageId: "msg-proposal1",
    created: { atSim: AT_SIM, by: "AGENT" },
  });
}

const decision = (value: "CONFIRM" | "REJECT") => ({ operationId: "op-4471", importerId: "imp-norpampa", firmId: FIRM, clockId: CLOCK, supplierId: "sup-qingdao", contactId: "ctc-qingdao-2", decision: value, messageId: "msg-tap1", wamid: WAMID, atSim: AT_SIM });

describe("confirm_supplier_contact [FL-011] [FL-014]", () => {
  it("[FL-014] the importer's button makes the contact ACTIVE (confirmedBy IMPORTER) and starts a CONTACT_CONFIRMED turn, once per wamid", async () => {
    const world = await serviceWorld();
    await proposed(world);
    const services = channelServices(world.deps);
    await services.confirmContact(decision("CONFIRM"));
    const contact = await world.stores.connector.parties.getContact("sup-qingdao", "ctc-qingdao-2");
    expect(contact).toMatchObject({ status: "ACTIVE", confirmedBy: "IMPORTER" });
    expect(world.events).toMatchObject([{ type: "AGENT_TURN", trigger: "CONTACT_CONFIRMED", operationId: "op-4471", messageId: "msg-tap1", eventId: turnEventId("CONTACT_CONFIRMED", WAMID) }]);
    await services.confirmContact(decision("CONFIRM"));
    expect(world.events).toHaveLength(1);
    const actions = (await world.stores.connector.audit.listByDecision(FIRM, "ACTION")).map((row) => row.action);
    expect(actions).toEqual(["CONTACT_CONFIRMED"]);
  });

  it("[FL-012] the importer's CONFIRM_CONTACT about the contact that already works stamps confirmedBy IMPORTER and opens the turn, once per tap", async () => {
    const world = await serviceWorld();
    const services = channelServices(world.deps);
    const known = { ...decision("CONFIRM"), contactId: "ctc-qingdao-1" };
    await services.confirmContact(known);
    expect(await world.stores.connector.parties.getContact("sup-qingdao", "ctc-qingdao-1")).toMatchObject({ status: "ACTIVE", confirmedBy: "IMPORTER" });
    expect(world.events).toMatchObject([{ trigger: "CONTACT_CONFIRMED", operationId: "op-4471", eventId: turnEventId("CONTACT_CONFIRMED", WAMID) }]);
    await services.confirmContact(known);
    expect(world.events).toHaveLength(1);
    const answer = unwrapDirect(await confirmSupplierContactHandler(world.deps)({ caller: consoleCaller(), contactId: "ctc-qingdao-1" }));
    expect(answer).toMatchObject({ changed: false, turns: 0 });
  });

  it("[FL-014] a rejection discards the proposed contact and its address claim, without a turn", async () => {
    const world = await serviceWorld();
    await proposed(world);
    await channelServices(world.deps).confirmContact(decision("REJECT"));
    expect(await world.stores.connector.parties.findContact("sup-qingdao", "ctc-qingdao-2")).toBeUndefined();
    expect(await world.stores.connector.parties.getAddressClaim(hashOf(PROPOSED))).toBeUndefined();
    expect(world.events).toEqual([]);
  });

  it("[FL-011] the console confirms with confirmedBy BROKER and a turn for each open operation of the supplier", async () => {
    const world = await serviceWorld();
    await proposed(world);
    const answer = unwrapDirect(await confirmSupplierContactHandler(world.deps)({ caller: consoleCaller(), contactId: "ctc-qingdao-2" }));
    expect(answer).toMatchObject({ changed: true, turns: 1, contact: { status: "ACTIVE", confirmedBy: "BROKER" } });
    expect(world.events).toMatchObject([{ trigger: "CONTACT_CONFIRMED", operationId: "op-4471" }]);
  });

  it("refuses a contact of another operation's supplier, a final contact, and a channel decision from the console", async () => {
    const world = await serviceWorld();
    await proposed(world);
    await world.stores.connector.parties.transitionContact({ supplierId: "sup-qingdao", contactId: "ctc-qingdao-2", to: "BOUNCED", atSim: AT_SIM, by: "SYSTEM" });
    const handler = confirmSupplierContactHandler(world.deps);
    expect(await handler({ caller: consoleCaller(), contactId: "ctc-qingdao-2" })).toMatchObject({ ok: false, error: { code: "CONFLICT", reason: "CONTACT_FINAL" } });
    const fromConsole = await handler({ caller: consoleCaller(), contactId: "ctc-qingdao-2", channel: { operationId: "op-4471", importerId: "imp-norpampa", supplierId: "sup-qingdao", decision: "CONFIRM", messageId: "msg-tap1", wamid: WAMID, atSim: AT_SIM } });
    expect(fromConsole).toMatchObject({ ok: false, error: { reason: "CHANNEL_ORIGIN" } });
    expect(await handler({ caller: consoleCaller("firm-norte"), contactId: "ctc-qingdao-2" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
