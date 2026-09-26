import { describe, expect, it } from "vitest";
import { DIEGO, PABLO, consoleWorld } from "./testing";

describe("registry router", () => {
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

  it("lists the world's suppliers with masked contacts, and nothing to another firm", async () => {
    const world = await consoleWorld();
    const { suppliers } = await world.caller(DIEGO).registry.suppliers.list({});
    expect(suppliers).toEqual([expect.objectContaining({ supplierId: "sup-qingdao", behaviour: "SEEDED_ERROR", contacts: [expect.objectContaining({ contactId: "ctc-qingdao-1", emailMasked: "s***@sim.legajo.demo.craftech.io" })] })]);
    expect((await world.caller(PABLO).registry.suppliers.list({})).suppliers).toEqual([]);
  });
});
