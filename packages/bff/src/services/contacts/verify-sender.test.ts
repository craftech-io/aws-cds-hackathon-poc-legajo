import { describe, expect, it } from "vitest";
import { createOperationHandler } from "../operations-admin/create-operation";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { FIRM, type ServiceWorld, consoleCaller, platformRow, serviceWorld } from "../operations-admin/testing";
import { verifySenderHandler } from "./verify-sender";

const CHANNEL = { kind: "CHANNEL" as const };
const ACTIVE = "supplier-qingdao@sim.legajo.demo.craftech.io";

/** An operation created through the handler, so its thread address carries the tag of the test key. */
async function threadOf(world: ServiceWorld): Promise<string> {
  world.platform.set(`${FIRM}#4479`, platformRow(FIRM, "4479"));
  const created = unwrapDirect(await createOperationHandler(world.deps)({ caller: consoleCaller(), operationNumber: "4479" }));
  return (await world.stores.connector.operations.getOperation(created.operationId)).threadAddress;
}

describe("verify_sender: email [FL-035] [FL-037]", () => {
  it("[FL-035] trusts only an ACTIVE contact of the operation's supplier with dmarcVerdict PASS", async () => {
    const world = await serviceWorld();
    const to = await threadOf(world);
    const verify = verifySenderHandler(world.deps);
    expect(unwrapDirect(await verify({ caller: CHANNEL, channel: "EMAIL", to, from: ACTIVE, dmarcVerdict: "PASS" }))).toMatchObject({ identity: "SUPPLIER", operationId: "op-4479", contactId: "ctc-qingdao-1" });
    expect(unwrapDirect(await verify({ caller: CHANNEL, channel: "EMAIL", to, from: ACTIVE, dmarcVerdict: "FAIL" }))).toMatchObject({ identity: "NONE", reason: "UNTRUSTED_SENDER" });
    expect(unwrapDirect(await verify({ caller: CHANNEL, channel: "EMAIL", to, from: "someone-else@sim.legajo.demo.craftech.io", dmarcVerdict: "PASS" }))).toMatchObject({ identity: "NONE", reason: "UNTRUSTED_SENDER" });
    expect(unwrapDirect(await verify({ caller: CHANNEL, channel: "EMAIL", to, dmarcVerdict: "PASS" }))).toMatchObject({ identity: "NONE", reason: "UNTRUSTED_SENDER" });
    const denies = await world.stores.connector.audit.listByDecision(FIRM, "DENY");
    expect(denies.map((row) => row.action)).toEqual(["UNTRUSTED_SENDER", "UNTRUSTED_SENDER", "UNTRUSTED_SENDER"]);
    expect(JSON.stringify(denies)).not.toContain("someone-else");
  });

  it("[FL-037] a thread address with a wrong tag or no operation is UNKNOWN_SENDER", async () => {
    const world = await serviceWorld();
    const to = await threadOf(world);
    const verify = verifySenderHandler(world.deps);
    const forged = to.replace(/-[0-9a-z]{6}@/, "-aaaaaa@");
    expect(unwrapDirect(await verify({ caller: CHANNEL, channel: "EMAIL", to: forged, from: ACTIVE, dmarcVerdict: "PASS" }))).toMatchObject({ identity: "NONE", reason: "UNKNOWN_SENDER" });
    expect(unwrapDirect(await verify({ caller: CHANNEL, channel: "EMAIL", to: "avisos@legajo.demo.craftech.io", from: ACTIVE, dmarcVerdict: "PASS" }))).toMatchObject({ identity: "NONE", reason: "UNKNOWN_SENDER" });
  });
});

describe("verify_sender: WhatsApp [FL-093]", () => {
  it("[FL-093] the registered phone is the importer; an unregistered one is UNKNOWN_SENDER", async () => {
    const world = await serviceWorld();
    const verify = verifySenderHandler(world.deps);
    expect(unwrapDirect(await verify({ caller: CHANNEL, channel: "WHATSAPP", phoneE164: "+5491155500101" }))).toMatchObject({ identity: "IMPORTER", importerId: "imp-norpampa", firmId: FIRM });
    expect(unwrapDirect(await verify({ caller: CHANNEL, channel: "WHATSAPP", phoneE164: "+5491155509999" }))).toEqual({ ok: true, identity: "NONE", reason: "UNKNOWN_SENDER" });
  });

  it("is only the channel's", async () => {
    const world = await serviceWorld();
    expect(await verifySenderHandler(world.deps)({ caller: consoleCaller(), channel: "WHATSAPP", phoneE164: "+5491155500101" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "CALLER_NOT_ALLOWED" } });
  });
});
