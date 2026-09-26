import { describe, expect, it } from "vitest";
import { DIEGO, PABLO, consoleWorld } from "./testing";

describe("registry router", () => {
  // FL-001, FL-003 and FL-004 need the registry mutations (registry.importers.upsert,
  // consent.record, authorization.set, suppliers.upsert, contacts.upsert) over the WP-43 services;
  // the tests below only read state seeded through the connector, so they carry no flow tag.
  it.todo("[FL-001:pending] importers.upsert + consent.record: ADDR# unique per phone, CONSENT#WHATSAPP in force, AuditLog ACTION CONSENT_GRANTED");
  it.todo("[FL-003:pending] authorization.set: AUTH#<supplierId> with authorizedAt and brokerId, AuditLog ACTION");
  it.todo("[FL-004:pending] suppliers.upsert + contacts.upsert: ACTIVE contact with its ADDR#, RECIPIENT_NOT_ALLOWED outside the fence, CONFLICT on an address of another contact or firm");

  it("lists the world's importers with the opt-in and authorizations in force, phones masked", async () => {
    const world = await consoleWorld();
    const { parties } = world.stores.connector;
    await parties.grantConsent({ importerId: "imp-norpampa", atSim: "2026-09-30T12:00:00-03:00", by: "SEED", medium: "SIGNED_FORM", textVersion: "v1" });
    await parties.setAuthorization({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: true, atSim: "2026-09-30T12:00:00-03:00", by: "SEED" });
    const { importers } = await world.caller(DIEGO).registry.importers.list({});
    expect(importers).toEqual([
      expect.objectContaining({
        importerId: "imp-norpampa",
        phoneMasked: "+54*******0101",
        consent: { status: "GRANTED", grantedAt: "2026-09-30T12:00:00-03:00", medium: "SIGNED_FORM", textVersion: "v1" },
        authorizations: [expect.objectContaining({ supplierId: "sup-qingdao", authorized: true })],
      }),
    ]);
    await parties.revokeConsent({ importerId: "imp-norpampa", atSim: "2026-10-15T09:00:00-03:00", by: "IMPORTER" });
    expect((await world.caller(DIEGO).registry.importers.list({})).importers[0]?.consent).toMatchObject({ status: "REVOKED" });
    expect(JSON.stringify(importers)).not.toContain("5550");
  });

  it("lists the world's suppliers with their ACTIVE contacts masked, and nothing to another firm", async () => {
    const world = await consoleWorld();
    const { suppliers } = await world.caller(DIEGO).registry.suppliers.list({});
    expect(suppliers).toEqual([expect.objectContaining({ supplierId: "sup-qingdao", behaviour: "SEEDED_ERROR", contacts: [expect.objectContaining({ contactId: "ctc-qingdao-1", emailMasked: "s***@sim.legajo.demo.craftech.io" })] })]);
    expect((await world.caller(PABLO).registry.suppliers.list({})).suppliers).toEqual([]);
  });
});
