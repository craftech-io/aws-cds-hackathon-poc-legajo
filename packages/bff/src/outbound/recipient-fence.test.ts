// The recipient fence the pipeline asks before rendering and the single SES client asks again before
// SES (docs/architecture-integrations.md §1, the cases it lists for this file; FL-004, FL-015, FL-059,
// FL-115): one module for the four sender profiles, the registry for WhatsApp, the fence of a contact
// the importer proposes, and `fence.probe`.
import { beforeEach, describe, expect, it } from "vitest";
import { NOTICES_ADDRESS, computeThreadTag, threadAddress } from "@legajo/shared";
import { TEST_THREAD_KEY } from "../channels/email/testing";
import { contactFixture, hashOf, operationFixture, supplierFixture } from "../connector/testing";
import type { Operation } from "../domain/operations";
import { probeFence, profileFence, proposedContactFence, whatsappFence } from "./recipient-fence";
import { DEMO_RECIPIENT, IMPORTER_PHONE, QINGDAO, SIM_NOW, outboundWorld, type OutboundWorld } from "./testing";

const QA_CLOCK = "qa-812-1-sc15";
const QA_SUPPLIER = "qa-812-1-sc15-qingdao-ab@sim.legajo.demo.craftech.io";
const QA_OTHER = "qa-812-1-sc15-santos-cd@sim.legajo.demo.craftech.io";
const INJECTOR = "qainject-812-1-sc15@sim.legajo.demo.craftech.io";

let world: OutboundWorld;

beforeEach(async () => {
  world = await outboundWorld({ demoRecipients: [DEMO_RECIPIENT] });
});

async function qaOperation(number: string, supplierId: string, contact: string): Promise<Operation> {
  const { connector } = world.stores;
  if ((await connector.world.findClock(QA_CLOCK)) === undefined) await connector.world.createClock({ clockId: QA_CLOCK, firmId: "firm-qa", mode: "PAUSED", pausedSimNow: SIM_NOW, startAtSim: SIM_NOW, worldEpoch: 1 });
  await connector.parties.createSupplier(supplierFixture({ supplierId, firmId: "firm-qa", clockId: QA_CLOCK }));
  await connector.parties.createContact(contactFixture({ contactId: `ctc-${supplierId.slice(4)}`, supplierId, firmId: "firm-qa", clockId: QA_CLOCK, email: contact, emailHash: hashOf(contact) }));
  const tag = await computeThreadTag(TEST_THREAD_KEY, { operationNumber: number, clockId: QA_CLOCK, worldEpoch: 1 });
  const address = threadAddress(number, tag);
  return connector.operations.createOperation({ ...operationFixture({ operationNumber: number, firmId: "firm-qa", clockId: QA_CLOCK, supplierId, importerId: "imp-norpampa", threadTag: tag }), threadAddress: address, threadClaimHash: hashOf(address) });
}

describe("[FL-059] the SYSTEM profile", () => {
  const system = (to: string, from?: string) => profileFence(world.deps.fence, { profile: "SYSTEM", from: from ?? world.op4471.threadAddress, to, operationId: world.op4471.operationId, clockId: world.op4471.clockId });

  it("writes to the simulated mailboxes, SES's simulator and the registered demo recipients", async () => {
    expect(await system(QINGDAO)).toMatchObject({ allowed: true });
    expect(await system("bounce@simulator.amazonses.com")).toMatchObject({ allowed: true });
    expect(await system(DEMO_RECIPIENT)).toMatchObject({ allowed: true });
    expect(await system(QINGDAO, NOTICES_ADDRESS)).toMatchObject({ allowed: true });
  });

  it("never to an operation's thread, a reserved domain, another domain or an address the parser refuses", async () => {
    expect(await system(world.op4483.threadAddress)).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "SYSTEM_TO_THREAD" });
    expect(await system("ventas@example.com")).toMatchObject({ allowed: false, reason: "RESERVED_DOMAIN" });
    expect(await system("compras@craftech.io")).toMatchObject({ allowed: false, reason: "SYSTEM_RECIPIENT" });
    expect(await system("someone@sim.legajo.demo.craftech.io.")).toMatchObject({ allowed: false, code: "INVALID", reason: "TO_ADDRESS_INVALID" });
    expect(await system("a@b@sim.legajo.demo.craftech.io")).toMatchObject({ allowed: false, reason: "TO_ADDRESS_INVALID" });
  });

  it("a From that is not the profile's, or the thread of another operation, is INVALID", async () => {
    expect(await system(QINGDAO, "notices@legajo.demo.craftech.io")).toMatchObject({ allowed: false, code: "INVALID", reason: "SYSTEM_FROM" });
    expect(await system(QINGDAO, world.op4483.threadAddress)).toMatchObject({ allowed: false, code: "INVALID", reason: "SYSTEM_FROM" });
  });
});

describe("[FL-059] the SIMULATOR profile", () => {
  const reply = (from: string, to: string, answered: { from: string; to: string }) => profileFence(world.deps.fence, { profile: "SIMULATOR", from, to, purpose: { kind: "REPLY", answered } });

  it("answers only the thread of the verified mail, from the contact it was sent to", async () => {
    const answered = { from: world.op4471.threadAddress, to: QINGDAO };
    expect(await reply(QINGDAO, world.op4471.threadAddress, answered)).toMatchObject({ allowed: true });
    expect(await reply(QINGDAO, "orders@sim.legajo.demo.craftech.io", answered)).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED" });
    expect(await reply(QINGDAO, world.op4483.threadAddress, answered)).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "SIMULATOR_NOT_ANSWERED_THREAD" });
  });

  it("refuses a From that is the contact of another operation's supplier, or no contact at all", async () => {
    const santos = "supplier-santosverde@sim.legajo.demo.craftech.io";
    expect(await reply(santos, world.op4471.threadAddress, { from: world.op4471.threadAddress, to: santos })).toMatchObject({ allowed: false, code: "INVALID", reason: "SIMULATOR_FROM" });
    const stranger = "nobody@sim.legajo.demo.craftech.io";
    expect(await reply(stranger, world.op4471.threadAddress, { from: world.op4471.threadAddress, to: stranger })).toMatchObject({ allowed: false, code: "INVALID", reason: "SIMULATOR_FROM" });
  });

  it("a QA world's supplier mailbox answers its own operation", async () => {
    const op = await qaOperation("7101", "sup-qaqingdao", QA_SUPPLIER);
    expect(await reply(QA_SUPPLIER, op.threadAddress, { from: op.threadAddress, to: QA_SUPPLIER })).toMatchObject({ allowed: true });
  });
});

describe("[FL-059] the QA profile", () => {
  const qa = (from: string, to: string) => profileFence(world.deps.fence, { profile: "QA", from, to });

  it("never reaches the thread of a demo or guest world", async () => {
    expect(await qa(INJECTOR, world.op4471.threadAddress)).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "QA_RECIPIENT" });
    const guest = await world.guestOperation("g41-supplier-qingdao@sim.legajo.demo.craftech.io");
    expect(await qa(INJECTOR, guest.threadAddress)).toMatchObject({ allowed: false, reason: "QA_RECIPIENT" });
  });

  it("from the injector or another operation's contact of the same QA world it may write; from the ACTIVE contact of the destination it may not", async () => {
    const op = await qaOperation("7101", "sup-qaqingdao", QA_SUPPLIER);
    await qaOperation("7102", "sup-qasantos", QA_OTHER);
    expect(await qa(INJECTOR, op.threadAddress)).toMatchObject({ allowed: true });
    expect(await qa(QA_OTHER, op.threadAddress)).toMatchObject({ allowed: true });
    expect(await qa(QA_SUPPLIER, op.threadAddress)).toMatchObject({ allowed: false, code: "INVALID", reason: "QA_FROM_ACTIVE_CONTACT" });
    expect(await qa(QINGDAO, op.threadAddress)).toMatchObject({ allowed: false, code: "INVALID", reason: "QA_FROM" });
  });
});

describe("[FL-115] the LEAD_NOTICE profile", () => {
  const notice = (to: string, from: string = NOTICES_ADDRESS) => profileFence(world.deps.fence, { profile: "LEAD_NOTICE", from, to });

  it("writes only to an exact @craftech.io mailbox, from avisos@", async () => {
    expect(await notice("ventas@craftech.io")).toMatchObject({ allowed: true });
    expect(await notice("ventas@leads.craftech.io")).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "LEAD_NOTICE_RECIPIENT" });
    expect(await notice("ventas@craftech.io.mirror-mail.net")).toMatchObject({ allowed: false, reason: "LEAD_NOTICE_RECIPIENT" });
    expect(await notice("ventas@notcraftech.io")).toMatchObject({ allowed: false, reason: "LEAD_NOTICE_RECIPIENT" });
    expect(await notice("ventas@craftech.io", world.op4471.threadAddress)).toMatchObject({ allowed: false, code: "INVALID", reason: "LEAD_NOTICE_FROM" });
  });
});

describe("WhatsApp goes only to the registered phone (LAM-RECIPIENT)", () => {
  it("allows the importer's phone in any notation and nothing else", () => {
    expect(whatsappFence({ to: "+54 9 11 5550-0101", registeredPhone: IMPORTER_PHONE })).toMatchObject({ allowed: true });
    expect(whatsappFence({ to: "+5491155500102", registeredPhone: IMPORTER_PHONE })).toMatchObject({ allowed: false, reason: "NOT_REGISTERED_PHONE" });
    expect(whatsappFence({ to: undefined, registeredPhone: IMPORTER_PHONE })).toMatchObject({ allowed: false, reason: "NO_REGISTERED_PHONE" });
  });
});

describe("[FL-015] [FL-004] a contact address before it is registered", () => {
  it("passes when the pipeline could write to it from the operation's thread, and is refused otherwise", async () => {
    expect(await proposedContactFence(world.deps.fence, world.op4471, "orders-qingdao@sim.legajo.demo.craftech.io")).toMatchObject({ allowed: true });
    expect(await proposedContactFence(world.deps.fence, world.op4471, "orders@bluewave-mail.com")).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "SYSTEM_RECIPIENT" });
    expect(await proposedContactFence(world.deps.fence, world.op4471, "orders@example.org")).toMatchObject({ allowed: false, reason: "RESERVED_DOMAIN" });
  });
});

describe("[FL-059] fence.probe", () => {
  const deps = () => ({ fence: world.deps.fence, data: world.stores.connector });

  it("answers the fence without sending, by profile and channel", async () => {
    expect(await probeFence(deps(), { clockId: world.op4471.clockId, profile: "SYSTEM", channel: "EMAIL", to: QINGDAO, operationId: "op-4471" })).toEqual({ allowed: true, ruleIds: ["CP-RECIPIENT-FENCE"] });
    expect(await probeFence(deps(), { clockId: world.op4471.clockId, profile: "SYSTEM", channel: "EMAIL", to: "ventas@example.com" })).toEqual({ allowed: false, ruleIds: ["CP-RECIPIENT-FENCE"], reason: "RESERVED_DOMAIN" });
    expect(await probeFence(deps(), { clockId: world.op4471.clockId, profile: "LEAD_NOTICE", channel: "EMAIL", to: "ventas@craftech.io" })).toEqual({ allowed: true, ruleIds: ["CP-RECIPIENT-FENCE"] });
    expect(await probeFence(deps(), { clockId: world.op4471.clockId, profile: "SIMULATOR", channel: "EMAIL", to: QINGDAO })).toEqual({ allowed: false, ruleIds: ["CP-RECIPIENT-FENCE"], reason: "PROFILE_NEEDS_A_MAIL" });
    expect(await probeFence(deps(), { clockId: world.op4471.clockId, profile: "SYSTEM", channel: "WHATSAPP", to: "+5491155500102", operationId: "op-4471" })).toMatchObject({ allowed: false, reason: "NOT_REGISTERED_PHONE" });
  });

  it("refuses an operation of another world", async () => {
    expect(await probeFence(deps(), { clockId: "GUEST#firm-guest-41", profile: "SYSTEM", channel: "EMAIL", to: QINGDAO, operationId: "op-4471" })).toEqual({ allowed: false, ruleIds: ["LAM-OP-SCOPE"], reason: "OPERATION_OF_ANOTHER_WORLD" });
  });
});
