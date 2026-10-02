import { describe, expect, it } from "vitest";
import { hashOf } from "../../connector/testing";
import { unwrapDirect } from "../operations-admin/handler-kit";
import { FIRM, consoleCaller, serviceWorld } from "../operations-admin/testing";
import { upsertPartyHandler } from "./upsert-party";

const NEW_IMPORTER = { name: "Litoral Envases SA", contactName: "Rocío Paz", contactFirstName: "Rocío", phoneE164: "+5491155500199", language: "es" as const };
const NEW_SUPPLIER = { name: "Harborline Packaging Ltd.", country: "GB", timezone: "Europe/London", language: "en" as const };

describe("upsert_party: importers [FL-001]", () => {
  it("[FL-001] creates the importer of the firm's world with its phone claimed (ADDR#) and audits it", async () => {
    const world = await serviceWorld();
    const upsert = upsertPartyHandler(world.deps);
    const answer = unwrapDirect(await upsert({ caller: consoleCaller(), party: "IMPORTER", data: NEW_IMPORTER }));
    expect(answer).toMatchObject({ party: "IMPORTER", created: true, importer: { clockId: "GLOBAL#firm-delta", phoneMasked: expect.not.stringContaining("55500") } });
    const claim = await world.stores.connector.parties.getAddressClaim(hashOf(NEW_IMPORTER.phoneE164));
    expect(claim?.ownerId).toMatch(/^imp-/);
    const actions = (await world.stores.connector.audit.listByDecision(FIRM, "ACTION")).map((row) => row.action);
    expect(actions).toEqual(["IMPORTER_CREATED"]);
  });

  it("refuses a phone another contact holds with CONFLICT and writes nothing", async () => {
    const world = await serviceWorld();
    const answer = await upsertPartyHandler(world.deps)({ caller: consoleCaller(), party: "IMPORTER", data: { ...NEW_IMPORTER, phoneE164: "+5491155500101" } });
    expect(answer).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await world.stores.connector.parties.listImporters(FIRM)).toHaveLength(1);
    const denies = await world.stores.connector.audit.listByDecision(FIRM, "DENY");
    expect(denies).toMatchObject([{ action: "IMPORTER_UPSERT_REFUSED", reason: "ADDRESS_CLAIMED" }]);
  });

  it("edits an importer and moves its phone claim", async () => {
    const world = await serviceWorld();
    const upsert = upsertPartyHandler(world.deps);
    const answer = unwrapDirect(await upsert({ caller: consoleCaller(), party: "IMPORTER", data: { ...NEW_IMPORTER, importerId: "imp-norpampa", phoneE164: "+5491155500198" } }));
    expect(answer).toMatchObject({ created: false, importer: { importerId: "imp-norpampa", name: NEW_IMPORTER.name } });
    expect((await world.stores.connector.parties.getAddressClaim(hashOf("+5491155500198")))?.ownerId).toBe("imp-norpampa");
  });

  it("[FL-082] refuses to edit an importer of another firm", async () => {
    const world = await serviceWorld();
    const answer = await upsertPartyHandler(world.deps)({ caller: consoleCaller("firm-norte"), party: "IMPORTER", data: { ...NEW_IMPORTER, importerId: "imp-norpampa" } });
    expect(answer).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "CROSS_FIRM" } });
  });
});

describe("upsert_party: suppliers and contacts [FL-004]", () => {
  it("[FL-004] registers the supplier with its contacts ACTIVE, confirmedBy BROKER, each address claimed", async () => {
    const world = await serviceWorld();
    const answer = unwrapDirect(await upsertPartyHandler(world.deps)({ caller: consoleCaller(), party: "SUPPLIER", data: { ...NEW_SUPPLIER, contacts: ["ventas-harborline@sim.legajo.demo.craftech.io"] } }));
    expect(answer).toMatchObject({ party: "SUPPLIER", created: true, supplier: { timezone: "Europe/London", behaviour: "PROMPT" }, contacts: [{ status: "ACTIVE", confirmedBy: "BROKER" }] });
    expect(await world.stores.connector.parties.getAddressClaim(hashOf("ventas-harborline@sim.legajo.demo.craftech.io"))).toBeDefined();
  });

  it("[FL-004] refuses an address outside the recipient fence (RECIPIENT_NOT_ALLOWED, DENY CP-RECIPIENT-FENCE) and writes nothing", async () => {
    const world = await serviceWorld();
    const answer = await upsertPartyHandler(world.deps)({ caller: consoleCaller(), party: "SUPPLIER", data: { ...NEW_SUPPLIER, contacts: ["export@harborline-packaging.co.uk"] } });
    expect(answer).toMatchObject({ ok: false, error: { code: "RECIPIENT_NOT_ALLOWED" } });
    expect(await world.stores.connector.parties.listSuppliers(FIRM)).toHaveLength(1);
    const denies = await world.stores.connector.audit.listByDecision(FIRM, "DENY");
    expect(denies).toMatchObject([{ action: "SUPPLIER_UPSERT_REFUSED", ruleIds: ["CP-RECIPIENT-FENCE"] }]);
  });

  it("[FL-004] refuses an address another contact holds with CONFLICT", async () => {
    const world = await serviceWorld();
    const answer = await upsertPartyHandler(world.deps)({ caller: consoleCaller(), party: "CONTACT", data: { supplierId: "sup-qingdao", email: "supplier-qingdao@sim.legajo.demo.craftech.io" } });
    expect(answer).toMatchObject({ ok: true, created: false, contacts: [{ contactId: "ctc-qingdao-1" }] });
    const other = await upsertPartyHandler(world.deps)({ caller: consoleCaller(), party: "SUPPLIER", data: { ...NEW_SUPPLIER, contacts: ["supplier-qingdao@sim.legajo.demo.craftech.io"] } });
    expect(other).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("refuses the injector mailbox, a qa- mailbox outside a QA world and an unknown time zone", async () => {
    const world = await serviceWorld();
    const upsert = upsertPartyHandler(world.deps);
    expect(await upsert({ caller: consoleCaller(), party: "CONTACT", data: { supplierId: "sup-qingdao", email: "qainject-812-1-sc15@sim.legajo.demo.craftech.io" } })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "INJECTOR_ADDRESS" } });
    expect(await upsert({ caller: consoleCaller(), party: "CONTACT", data: { supplierId: "sup-qingdao", email: "qa-812-sc16-supplier@sim.legajo.demo.craftech.io" } })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "QA_PARTY_PREFIX" } });
    expect(await upsert({ caller: consoleCaller(), party: "SUPPLIER", data: { ...NEW_SUPPLIER, timezone: "Mars/Olympus" } })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "TIMEZONE_INVALID" } });
  });

  it("adds a contact to a supplier and audits CONTACT_ADDED", async () => {
    const world = await serviceWorld();
    const answer = unwrapDirect(await upsertPartyHandler(world.deps)({ caller: consoleCaller(), party: "CONTACT", data: { supplierId: "sup-qingdao", email: "logistics-qingdao@sim.legajo.demo.craftech.io" } }));
    expect(answer).toMatchObject({ party: "CONTACT", contacts: [{ status: "ACTIVE", confirmedBy: "BROKER" }] });
    const actions = (await world.stores.connector.audit.listByDecision(FIRM, "ACTION")).map((row) => row.action);
    expect(actions).toEqual(["CONTACT_ADDED"]);
  });

  it("refuses keys the input does not declare (LAM-STRICT) and a party the catalog does not know", async () => {
    const world = await serviceWorld();
    const upsert = upsertPartyHandler(world.deps);
    expect(await upsert({ caller: consoleCaller(), party: "SUPPLIER", data: { ...NEW_SUPPLIER, firmId: "firm-norte" } })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "VALIDATION" } });
    expect(await upsert({ caller: consoleCaller(), party: "BROKER", data: {} })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });
});
