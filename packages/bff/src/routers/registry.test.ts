import { describe, expect, it } from "vitest";
import { hashOf } from "../connector/testing";
import { CLOCK, FIRM, OPERATION, START_SIM } from "../services/operations-admin/testing";
import { consoleServiceWorld } from "./console-testing";
import { DIEGO, MARTINA, PABLO, consoleWorld } from "./testing";

const NEW_IMPORTER = { name: "Litoral Envases SA", contactName: "Rocío Paz", contactFirstName: "Rocío", phoneE164: "+5491155500199", language: "es" as const };
const NEW_SUPPLIER = { name: "Harborline Packaging Ltd.", country: "GB", timezone: "Europe/London", language: "en" as const };

describe("registry router: changes", () => {
  it("[FL-001] registers an importer with its phone claimed and records its WhatsApp opt-in, both audited", async () => {
    const world = await consoleServiceWorld();
    const created = (await world.caller(MARTINA).registry.importers.upsert(NEW_IMPORTER)) as { importer: { importerId: string; phoneMasked: string } };
    expect(created).toMatchObject({ party: "IMPORTER", created: true, importer: { clockId: "GLOBAL#firm-delta" } });
    expect(JSON.stringify(created)).not.toContain("55500199");
    expect((await world.stores.connector.parties.getAddressClaim(hashOf(NEW_IMPORTER.phoneE164)))?.ownerId).toBe(created.importer.importerId);
    await expect(world.caller(DIEGO).registry.importers.upsert({ ...NEW_IMPORTER, phoneE164: "+5491155500101" })).rejects.toMatchObject({ code: "CONFLICT" });

    const { importerId } = created.importer;
    await world.caller(MARTINA).registry.consent.record({ importerId, medium: "SIGNED_FORM", grantedAt: "2026-10-13T11:00:00-03:00", textVersion: "v1" });
    expect(await world.stores.connector.parties.getConsent(importerId)).toMatchObject({ grantedAt: "2026-10-13T11:00:00-03:00", medium: "SIGNED_FORM" });
    const actions = (await world.stores.connector.audit.listByDecision(FIRM, "ACTION")).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["IMPORTER_CREATED", "CONSENT_GRANTED"]));
    expect((await world.caller(DIEGO).registry.importers.list({})).importers.find((row) => row.importerId === importerId)?.consent).toMatchObject({ status: "GRANTED" });
  });

  it("[FL-006] revokes the opt-in from the console", async () => {
    const world = await consoleServiceWorld();
    await world.caller(DIEGO).registry.consent.record({ importerId: "imp-norpampa", medium: "EMAIL", grantedAt: "2026-10-13T11:00:00-03:00", textVersion: "v1" });
    await world.caller(DIEGO).registry.consent.revoke({ importerId: "imp-norpampa", reason: "Pidió no recibir más avisos" });
    expect((await world.caller(DIEGO).registry.importers.list({})).importers[0]?.consent).toMatchObject({ status: "REVOKED" });
  });

  it("[FL-003] authorizes the agent to write to the importer's supplier, signed by the broker", async () => {
    const world = await consoleServiceWorld();
    await world.caller(DIEGO).registry.authorization.set({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: true });
    const [authorization] = await world.stores.connector.parties.listAuthorizations("imp-norpampa");
    expect(authorization).toMatchObject({ supplierId: "sup-qingdao", authorized: true });
    const row = (await world.stores.connector.audit.listByDecision(FIRM, "ACTION")).at(-1);
    expect(row?.refs).toMatchObject({ brokerId: "brk-delta-diego" });
    await expect(world.caller(PABLO).registry.authorization.set({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("[FL-004] registers a supplier and a contact ACTIVE with their addresses claimed, refuses one outside the fence and one another contact holds", async () => {
    const world = await consoleServiceWorld();
    const created = (await world.caller(DIEGO).registry.suppliers.upsert({ ...NEW_SUPPLIER, contacts: ["ventas-harborline@sim.legajo.demo.craftech.io"] })) as { supplier: { supplierId: string } };
    expect(created).toMatchObject({ created: true, contacts: [{ status: "ACTIVE", confirmedBy: "BROKER" }] });
    expect(await world.stores.connector.parties.getAddressClaim(hashOf("ventas-harborline@sim.legajo.demo.craftech.io"))).toBeDefined();
    await world.caller(DIEGO).registry.contacts.upsert({ supplierId: created.supplier.supplierId, email: "compras-harborline@sim.legajo.demo.craftech.io" });
    expect(await world.stores.connector.parties.listContacts(created.supplier.supplierId)).toHaveLength(2);

    await expect(world.caller(DIEGO).registry.suppliers.upsert({ ...NEW_SUPPLIER, contacts: ["export@harborline-packaging.co.uk"] })).rejects.toMatchObject({ code: "FORBIDDEN", cause: { code: "RECIPIENT_NOT_ALLOWED" } });
    await expect(world.caller(DIEGO).registry.contacts.upsert({ supplierId: created.supplier.supplierId, email: "supplier-qingdao@sim.legajo.demo.craftech.io" })).rejects.toMatchObject({ code: "CONFLICT" });
    const denies = await world.stores.connector.audit.listByDecision(FIRM, "DENY");
    expect(denies.some((row) => row.ruleIds.includes("CP-RECIPIENT-FENCE"))).toBe(true);
  });

  it("confirms a contact proposed by the agent", async () => {
    const world = await consoleServiceWorld();
    const { parties } = world.stores.connector;
    const email = "ops-qingdao@sim.legajo.demo.craftech.io";
    await parties.createContact({ contactId: "ctc-qingdao-2", supplierId: "sup-qingdao", firmId: FIRM, clockId: CLOCK, email, emailHash: hashOf(email), status: "PENDING_CONFIRMATION", sourceMessageId: "msg-proposal1", created: { atSim: START_SIM, by: "AGENT" } });
    expect(await world.caller(DIEGO).registry.contacts.confirm({ contactId: "ctc-qingdao-2" })).toMatchObject({ changed: true, contact: { contactId: "ctc-qingdao-2", confirmedBy: "BROKER" } });
    expect((await parties.findContact("sup-qingdao", "ctc-qingdao-2"))?.status).toBe("ACTIVE");
  });

  it("[FL-088] sets the simulated supplier's behaviour for the supplier or one of its operations, audited", async () => {
    const world = await consoleServiceWorld();
    expect(await world.caller(DIEGO).registry.supplierBehaviour.set({ supplierId: "sup-qingdao", behaviour: "LATE" })).toEqual({ supplierId: "sup-qingdao", behaviour: "LATE" });
    expect((await world.stores.connector.parties.getSupplier("sup-qingdao")).behaviour).toBe("LATE");
    await world.caller(DIEGO).registry.supplierBehaviour.set({ supplierId: "sup-qingdao", behaviour: "NEVER", operationId: OPERATION });
    expect((await world.stores.connector.operations.getOperation(OPERATION)).simBehaviour).toBe("NEVER");
    const rows = (await world.stores.connector.audit.listByDecision(FIRM, "ACTION")).filter((row) => row.action === "SUPPLIER_BEHAVIOUR_SET");
    expect(rows.map((row) => row.detail)).toEqual([expect.objectContaining({ scope: "SUPPLIER" }), expect.objectContaining({ scope: "OPERATION" })]);
    await expect(world.caller(PABLO).registry.supplierBehaviour.set({ supplierId: "sup-qingdao", behaviour: "PROMPT" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

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

  it("lists the world's suppliers with their ACTIVE contacts masked, and nothing to another firm", async () => {
    const world = await consoleWorld();
    const { suppliers } = await world.caller(DIEGO).registry.suppliers.list({});
    expect(suppliers).toEqual([expect.objectContaining({ supplierId: "sup-qingdao", behaviour: "SEEDED_ERROR", contacts: [expect.objectContaining({ contactId: "ctc-qingdao-1", emailMasked: "s***@sim.legajo.demo.craftech.io" })] })]);
    expect((await world.caller(PABLO).registry.suppliers.list({})).suppliers).toEqual([]);
  });
});
