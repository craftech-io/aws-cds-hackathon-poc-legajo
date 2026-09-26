import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { consentActiveAt, authorizationActiveAt, contactStatusAt } from "../../domain/parties";
import type { MemoryStores } from "../memory/index";
import { CLOCK, FIRM, REAL_NOW, contactFixture, hashOf, importerFixture, memoryStores, supplierFixture } from "../testing";
import { createConnector } from "../connector";
import { DynamoTableClient } from "./client";

const GRANTED_AT = "2026-09-30T11:00:00-03:00";

describe("parties: importers and their phone claim", () => {
  let stores: MemoryStores;

  beforeEach(() => {
    stores = memoryStores();
  });

  it("[FL-001] registers an importer with its phoneHash, a unique ADDR# claim and a dated WhatsApp opt-in", async () => {
    const { parties, audit } = stores.connector;
    const importer = await parties.createImporter(importerFixture());
    expect(importer).toMatchObject({ importerId: "imp-norpampa", phoneHash: hashOf("+5491155500101"), version: 1, synthetic: false });

    const meta = await stores.client.get("Parties", { PK: "IMP#imp-norpampa", SK: "META" });
    expect(meta).toMatchObject({ entity: "Importer", phoneHash: hashOf("+5491155500101"), firmKey: "FIRM#firm-delta#IMP", sortName: "norpampa insumos srl" });
    const claim = await parties.getAddressClaim(hashOf("+5491155500101"));
    expect(claim).toMatchObject({ kind: "PHONE", ownerType: "IMPORTER", ownerId: "imp-norpampa", firmId: FIRM });
    expect(await parties.findImporterByPhoneHash(hashOf("+5491155500101"))).toMatchObject({ status: "UNIQUE", value: { importerId: "imp-norpampa" } });

    const consent = await parties.grantConsent({ importerId: "imp-norpampa", atSim: GRANTED_AT, by: "BROKER:brk-delta-martina", medium: "SIGNED_FORM", textVersion: "v1" });
    expect(consent).toMatchObject({ channel: "WHATSAPP", grantedAt: GRANTED_AT, medium: "SIGNED_FORM", textVersion: "v1", firmId: FIRM, clockId: CLOCK });
    expect(consent.revokedAt).toBeUndefined();
    expect(consent.history).toEqual([{ action: "GRANTED", atSim: GRANTED_AT, by: "BROKER:brk-delta-martina", medium: "SIGNED_FORM", textVersion: "v1" }]);
    expect(consentActiveAt(consent, "2026-10-14T10:30:00-03:00")).toBe(true);

    const decision = await audit.record({ firmId: FIRM, decision: "ACTION", action: "CONSENT_GRANTED", actor: "BROKER:brk-delta-martina", atReal: REAL_NOW, refs: { importerId: "imp-norpampa" } });
    expect(await audit.listByDecision(FIRM, "ACTION")).toEqual([decision]);
  });

  it("[FL-001] refuses a second importer with the same phone and writes nothing (one phone = one contact)", async () => {
    const { parties } = stores.connector;
    await parties.createImporter(importerFixture());
    await expect(parties.createImporter(importerFixture({ importerId: "imp-cuyo", name: "Vientos de Cuyo SA" }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await parties.findImporter("imp-cuyo")).toBeUndefined();
    expect((await parties.getAddressClaim(hashOf("+5491155500101")))?.ownerId).toBe("imp-norpampa");
    expect(await parties.listImporters(FIRM)).toHaveLength(1);
  });

  it("moves the phone claim with the phone, and refuses a phone that belongs to someone else", async () => {
    const { parties } = stores.connector;
    await parties.createImporter(importerFixture());
    await parties.createImporter(importerFixture({ importerId: "imp-cuyo", name: "Vientos de Cuyo SA", phoneE164: "+5491155500102", phoneHash: hashOf("+5491155500102") }));

    const moved = await parties.updateImporter("imp-norpampa", { phoneE164: "+5491155500103", phoneHash: hashOf("+5491155500103") }, 1);
    expect(moved).toMatchObject({ phoneHash: hashOf("+5491155500103"), version: 2 });
    expect(await parties.getAddressClaim(hashOf("+5491155500101"))).toBeUndefined();
    expect((await parties.getAddressClaim(hashOf("+5491155500103")))?.ownerId).toBe("imp-norpampa");

    await expect(parties.updateImporter("imp-norpampa", { phoneE164: "+5491155500102", phoneHash: hashOf("+5491155500102") })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await parties.getImporter("imp-norpampa")).phoneHash).toBe(hashOf("+5491155500103"));
    await expect(parties.updateImporter("imp-norpampa", { name: "Otro" }, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(parties.releaseAddress(hashOf("+5491155500102"), "imp-norpampa")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("never picks one of two importers that share a phone hash", async () => {
    const { parties } = stores.connector;
    await parties.createImporter(importerFixture());
    // Two rows with the same hash can only exist if someone bypassed the claims; the lookup refuses to choose.
    const twin = { ...(await stores.client.get("Parties", { PK: "IMP#imp-norpampa", SK: "META" })), PK: "IMP#imp-twin", SK: "META", importerId: "imp-twin" };
    await stores.client.put("Parties", twin);
    expect(await parties.findImporterByPhoneHash(hashOf("+5491155500101"))).toEqual({ status: "AMBIGUOUS", ids: ["imp-norpampa", "imp-twin"] });
    expect(await parties.findImporterByPhoneHash(hashOf("+5491155500199"))).toEqual({ status: "NONE" });
  });

  it("keeps the opt-in history, so the state at any past simulated instant can be rebuilt", async () => {
    const { parties } = stores.connector;
    await parties.createImporter(importerFixture());
    await expect(parties.revokeConsent({ importerId: "imp-norpampa", atSim: GRANTED_AT, by: "IMPORTER" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await parties.grantConsent({ importerId: "imp-norpampa", atSim: GRANTED_AT, by: "BROKER:brk-delta-martina", medium: "SIGNED_FORM", textVersion: "v1" });
    const revoked = await parties.revokeConsent({ importerId: "imp-norpampa", atSim: "2026-10-15T12:00:00-03:00", by: "IMPORTER", reason: "OPT_OUT_BUTTON" });
    expect(revoked).toMatchObject({ revokedAt: "2026-10-15T12:00:00-03:00", revokeReason: "OPT_OUT_BUTTON", version: 2 });
    const regranted = await parties.grantConsent({ importerId: "imp-norpampa", atSim: "2026-10-16T10:00:00-03:00", by: "BROKER:brk-delta-martina", medium: "EMAIL", textVersion: "v1" });
    expect(regranted.revokedAt).toBeUndefined();
    expect(regranted.history.map((event) => event.action)).toEqual(["GRANTED", "REVOKED", "GRANTED"]);
    expect(consentActiveAt(regranted, "2026-09-29T10:00:00-03:00")).toBe(false);
    expect(consentActiveAt(regranted, "2026-10-15T11:59:00-03:00")).toBe(true);
    expect(consentActiveAt(regranted, "2026-10-15T15:00:00-03:00")).toBe(false);
    expect(consentActiveAt(regranted, "2026-10-16T10:00:00-03:00")).toBe(true);
  });

  it("records authorizations with their history and only for a supplier of the importer's firm", async () => {
    const { parties } = stores.connector;
    await parties.createImporter(importerFixture());
    await parties.createSupplier(supplierFixture());
    await parties.createSupplier(supplierFixture({ supplierId: "sup-n-qingdao", firmId: "firm-norte", clockId: "GLOBAL#firm-norte" }));
    const on = await parties.setAuthorization({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: true, atSim: GRANTED_AT, by: "BROKER:brk-delta-martina", brokerId: "brk-delta-martina" });
    expect(on).toMatchObject({ authorized: true, authorizedAt: GRANTED_AT, brokerId: "brk-delta-martina" });
    const off = await parties.setAuthorization({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: false, atSim: "2026-10-15T09:00:00-03:00", by: "BROKER:brk-delta-martina" });
    expect(off).toMatchObject({ authorized: false, revokedAt: "2026-10-15T09:00:00-03:00", version: 2 });
    expect(authorizationActiveAt(off, "2026-10-14T10:30:00-03:00")).toBe(true);
    expect(authorizationActiveAt(off, "2026-10-15T09:00:00-03:00")).toBe(false);
    expect(await parties.listAuthorizations("imp-norpampa")).toHaveLength(1);
    await expect(parties.setAuthorization({ importerId: "imp-norpampa", supplierId: "sup-n-qingdao", authorized: true, atSim: GRANTED_AT, by: "SEED" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("parties: suppliers and contacts", () => {
  let stores: MemoryStores;

  beforeEach(async () => {
    stores = memoryStores();
    await stores.connector.parties.createSupplier(supplierFixture());
  });

  it("claims the contact's email and refuses the same email for another contact", async () => {
    const { parties } = stores.connector;
    const contact = await parties.createContact(contactFixture());
    expect(contact.statusHistory).toEqual([{ atSim: "2026-09-30T12:00:00-03:00", by: "SEED", status: "ACTIVE" }]);
    expect((await parties.getAddressClaim(contact.emailHash))?.ownerType).toBe("SUPPLIER_CONTACT");
    expect((await parties.findContactsByEmailHash(contact.emailHash)).map((found) => found.contactId)).toEqual(["ctc-qingdao-1"]);
    await expect(parties.createContact(contactFixture({ contactId: "ctc-qingdao-2" }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await parties.listContacts("sup-qingdao")).toHaveLength(1);
  });

  it("moves a proposed contact through its statuses with a dated history; BOUNCED never comes back", async () => {
    const { parties } = stores.connector;
    const email = "supplier-qingdao-ops@sim.legajo.demo.craftech.io";
    const proposed = await parties.createContact(
      contactFixture({ contactId: "ctc-qingdao-2", email, emailHash: hashOf(email), status: "PENDING_CONFIRMATION", confirmedBy: undefined, confirmedAt: undefined, created: { atSim: "2026-10-15T10:05:00-03:00", by: "AGENT" } }),
    );
    expect(proposed.status).toBe("PENDING_CONFIRMATION");
    const base = { supplierId: "sup-qingdao", contactId: "ctc-qingdao-2" };
    await expect(parties.transitionContact({ ...base, to: "ACTIVE", atSim: "2026-10-15T10:07:00-03:00", by: "IMPORTER" })).rejects.toMatchObject({ code: "VALIDATION" });
    const active = await parties.transitionContact({ ...base, to: "ACTIVE", confirmedBy: "IMPORTER", atSim: "2026-10-15T10:07:00-03:00", by: "IMPORTER" });
    expect(active).toMatchObject({ status: "ACTIVE", confirmedBy: "IMPORTER", confirmedAt: "2026-10-15T10:07:00-03:00", version: 2 });
    await expect(parties.transitionContact({ ...base, to: "BOUNCED", atSim: "2026-10-15T12:00:00-03:00", by: "SYSTEM", expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    const bounced = await parties.transitionContact({ ...base, to: "BOUNCED", atSim: "2026-10-15T12:00:00-03:00", by: "SYSTEM", reason: "Permanent" });
    expect(bounced).toMatchObject({ status: "BOUNCED", bouncedAt: "2026-10-15T12:00:00-03:00" });
    expect(contactStatusAt(bounced, "2026-10-15T11:00:00-03:00")).toBe("ACTIVE");
    await expect(parties.transitionContact({ ...base, to: "ACTIVE", confirmedBy: "BROKER", atSim: "2026-10-15T13:00:00-03:00", by: "BROKER:brk-delta-diego" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(parties.discardContact("sup-qingdao", "ctc-qingdao-2")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("discards a proposed contact the importer rejected, releasing its email", async () => {
    const { parties } = stores.connector;
    const email = "someone-else@sim.legajo.demo.craftech.io";
    await parties.createContact(contactFixture({ contactId: "ctc-qingdao-3", email, emailHash: hashOf(email), status: "PENDING_CONFIRMATION", confirmedBy: undefined, confirmedAt: undefined }));
    await parties.discardContact("sup-qingdao", "ctc-qingdao-3", 1);
    expect(await parties.findContact("sup-qingdao", "ctc-qingdao-3")).toBeUndefined();
    expect(await parties.getAddressClaim(hashOf(email))).toBeUndefined();
  });

  it("refuses a contact of a supplier of another firm, lists the registry by sort name and stamps QA worlds", async () => {
    const { parties } = stores.connector;
    await expect(parties.createContact(contactFixture({ firmId: "firm-norte" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await parties.createSupplier(supplierFixture({ supplierId: "sup-elbhafen", name: "Elbhafen Tools GmbH", country: "DE", timezone: "Europe/Berlin" }));
    expect((await parties.listSuppliers(FIRM)).map((supplier) => supplier.supplierId)).toEqual(["sup-elbhafen", "sup-qingdao"]);
    const qa = await parties.createImporter(importerFixture({ importerId: "imp-qa-812-sc16-a", clockId: "qa-812-sc16", firmId: "firm-qa", phoneE164: "+5491155509001", phoneHash: hashOf("+5491155509001") }));
    expect(qa).toMatchObject({ world: "qa", expiresAt: Date.parse(REAL_NOW) / 1000 + 48 * 3600 });
    expect(await parties.listImporters("firm-qa", { clockId: "qa-812-sc16" })).toHaveLength(1);
    expect(await parties.listImporters("firm-qa", { clockId: "qa-812-sc17" })).toHaveLength(0);
  });

  it("recomputes the measured profile in place, keeping when it was created", async () => {
    const { parties } = stores.connector;
    const first = await parties.putProfile({ supplierId: "sup-qingdao", firmId: FIRM, clockId: CLOCK, medianReplyHours: 6, lateDocTypes: ["CERTIFICATE_OF_ORIGIN"], repliesMeasured: 4, bounces: 0 });
    const second = await parties.putProfile({ supplierId: "sup-qingdao", firmId: FIRM, clockId: CLOCK, medianReplyHours: 5, lateDocTypes: [], repliesMeasured: 5, bounces: 0 });
    expect(second).toMatchObject({ medianReplyHours: 5, version: 2, createdAt: first.createdAt });
  });
});

describe("parties over DynamoDB", () => {
  const docMock = mockClient(DynamoDBDocumentClient);

  it("[FL-001] writes the importer and its ADDR# claim in one transaction, both conditional on not existing", async () => {
    docMock.reset();
    docMock.on(TransactWriteCommand).resolves({});
    const client = new DynamoTableClient(DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })), { resolveName: (table) => `poc-${table}` });
    const connector = createConnector({ client, now: () => new Date(REAL_NOW), newId: () => "ID1" });
    await connector.parties.createImporter(importerFixture());
    const items = docMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items.map((item) => [item.Put?.Item?.PK, item.Put?.Item?.SK, item.Put?.ConditionExpression])).toEqual([
      ["IMP#imp-norpampa", "META", "attribute_not_exists(#n0)"],
      [`ADDR#${hashOf("+5491155500101")}`, "CLAIM", "attribute_not_exists(#n0)"],
    ]);
    expect(items[1]?.Put?.Item).toMatchObject({ entity: "AddressClaim", addressHash: hashOf("+5491155500101"), ownerId: "imp-norpampa" });
    expect(items[1]?.Put?.Item?.phoneHash).toBeUndefined();
  });
});
