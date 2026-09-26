// `Parties`, supplier side: suppliers (registry GSI3), their contacts with the email claim
// (`ADDR#<emailHash>`, conditional, same transaction) and the dated status history, and the
// measured profile. The agent only writes to an ACTIVE, confirmed contact; BOUNCED and COMPLAINED
// never come back (`CONTACT_TRANSITIONS`).
import { ConnectorError } from "@legajo/shared";
import { CONTACT_TRANSITIONS, ContactStatusEvent, Supplier, SupplierContact, SupplierProfile } from "../../domain/parties";
import type { TableName } from "../../lib/resource";
import { expectedIndexAttributes } from "../item-shape";
import { CONTACT_PREFIX, contactKey, registryKey, sortNameOf, supplierKey, supplierPartition, supplierProfileKey } from "../keys";
import type { PartiesPort } from "../ports";
import { claimRow, releaseClaimOp } from "./address-claims";
import { buildRow, checked, checkPatch, createRow, defined, optionalEntity, parseEntities, replaceRow, requireEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "Parties";

type SupplierMethods = Pick<
  PartiesPort,
  | "getSupplier"
  | "findSupplier"
  | "listSuppliers"
  | "createSupplier"
  | "updateSupplier"
  | "getContact"
  | "findContact"
  | "listContacts"
  | "findContactsByEmailHash"
  | "createContact"
  | "transitionContact"
  | "discardContact"
  | "getProfile"
  | "putProfile"
>;

export function suppliersRepo(ctx: RepoContext): SupplierMethods {
  const { client } = ctx;

  const getSupplier = async (supplierId: string): Promise<Supplier> =>
    requireEntity(Supplier, "Supplier", await client.get(TABLE, supplierKey(supplierId)), TABLE, `supplier ${supplierId}`);

  const getContact = async (supplierId: string, contactId: string): Promise<SupplierContact> =>
    requireEntity(SupplierContact, "SupplierContact", await client.get(TABLE, contactKey(supplierId, contactId)), TABLE, `contact ${contactId}`);

  return {
    getSupplier,
    getContact,

    async findSupplier(supplierId) {
      return optionalEntity(Supplier, "Supplier", await client.get(TABLE, supplierKey(supplierId)), TABLE);
    },

    async listSuppliers(firmId, options = {}) {
      const rows = await client.query(TABLE, {
        index: "GSI3",
        hashValue: registryKey(firmId, "SUP"),
        filter: { equals: { entity: "Supplier", ...(options.clockId === undefined ? {} : { clockId: options.clockId }) } },
      });
      return parseEntities(Supplier, "Supplier", rows, TABLE);
    },

    async createSupplier(supplier) {
      return createRow(ctx, TABLE, Supplier, "Supplier", supplierKey(supplier.supplierId), supplier, { gsi: expectedIndexAttributes("Supplier", supplier) });
    },

    async updateSupplier(supplierId, patch, expectedVersion) {
      const fields = checkPatch(Supplier, patch, TABLE, `supplier ${supplierId}`);
      const current = await getSupplier(supplierId);
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw new ConnectorError("CONFLICT", `supplier ${supplierId} changed`, TABLE);
      const set = { ...fields, ...(typeof fields.name === "string" ? { sortName: sortNameOf(fields.name) } : {}) };
      return updateRow(ctx, TABLE, Supplier, "Supplier", supplierKey(supplierId), { set }, { condition: { ifVersion: current.version } });
    },

    async findContact(supplierId, contactId) {
      return optionalEntity(SupplierContact, "SupplierContact", await client.get(TABLE, contactKey(supplierId, contactId)), TABLE);
    },

    async listContacts(supplierId) {
      const rows = await client.query(TABLE, { hashValue: supplierPartition(supplierId), range: { prefix: CONTACT_PREFIX } });
      return parseEntities(SupplierContact, "SupplierContact", rows, TABLE);
    },

    async findContactsByEmailHash(emailHash) {
      const rows = await client.query(TABLE, { index: "GSI2", hashValue: emailHash, filter: { equals: { entity: "SupplierContact" } } });
      return parseEntities(SupplierContact, "SupplierContact", rows, TABLE);
    },

    async createContact(input) {
      const { created, ...contact } = input;
      const supplier = await getSupplier(contact.supplierId);
      if (supplier.firmId !== contact.firmId) throw new ConnectorError("VALIDATION", `supplier ${contact.supplierId} is not of firm ${contact.firmId}`, TABLE);
      const first = checked(ContactStatusEvent, TABLE, defined({ ...created, status: contact.status }));
      const built = buildRow(ctx, TABLE, SupplierContact, "SupplierContact", contactKey(contact.supplierId, contact.contactId), { ...contact, statusHistory: [first] });
      const claim = claimRow(ctx, { addressHash: contact.emailHash, kind: "EMAIL", ownerType: "SUPPLIER_CONTACT", ownerId: contact.contactId, firmId: contact.firmId, clockId: contact.clockId });
      await client.transact([
        { op: "put", table: TABLE, item: built.item, condition: { ifNotExists: true } },
        { op: "put", table: TABLE, item: claim, condition: { ifNotExists: true } },
      ]);
      return built.value;
    },

    async transitionContact(transition) {
      const current = await getContact(transition.supplierId, transition.contactId);
      if (transition.expectedVersion !== undefined && transition.expectedVersion !== current.version) {
        throw new ConnectorError("CONFLICT", `contact ${transition.contactId} changed`, TABLE);
      }
      if (!CONTACT_TRANSITIONS[current.status].includes(transition.to)) {
        throw new ConnectorError("VALIDATION", `contact ${transition.contactId} cannot go from ${current.status} to ${transition.to}`, TABLE);
      }
      if (transition.to === "ACTIVE" && transition.confirmedBy === undefined) throw new ConnectorError("VALIDATION", "a confirmation says who confirmed", TABLE);
      const event = checked(ContactStatusEvent, TABLE, defined({ atSim: transition.atSim, atReal: transition.atReal, by: transition.by, reason: transition.reason, status: transition.to }));
      const set: Record<string, unknown> = { status: transition.to };
      if (transition.to === "ACTIVE") Object.assign(set, { confirmedAt: transition.atSim, confirmedBy: transition.confirmedBy });
      if (transition.to === "BOUNCED") set.bouncedAt = transition.atSim;
      if (transition.to === "COMPLAINED") set.complainedAt = transition.atSim;
      return updateRow(ctx, TABLE, SupplierContact, "SupplierContact", contactKey(transition.supplierId, transition.contactId), { set, append: { statusHistory: [event] } }, {
        condition: { ifVersion: current.version, equals: { status: current.status } },
      });
    },

    async discardContact(supplierId, contactId, expectedVersion) {
      const contact = await getContact(supplierId, contactId);
      if (expectedVersion !== undefined && expectedVersion !== contact.version) throw new ConnectorError("CONFLICT", `contact ${contactId} changed`, TABLE);
      if (contact.status !== "PENDING_CONFIRMATION") throw new ConnectorError("VALIDATION", `only a proposed contact can be discarded, ${contactId} is ${contact.status}`, TABLE);
      await client.transact([
        { op: "delete", table: TABLE, key: contactKey(supplierId, contactId), condition: { ifVersion: contact.version, equals: { status: "PENDING_CONFIRMATION" } } },
        releaseClaimOp(contact.emailHash, contactId),
      ]);
    },

    async getProfile(supplierId) {
      return optionalEntity(SupplierProfile, "SupplierProfile", await client.get(TABLE, supplierProfileKey(supplierId)), TABLE);
    },

    async putProfile(profile) {
      return replaceRow(ctx, TABLE, SupplierProfile, "SupplierProfile", supplierProfileKey(profile.supplierId), profile);
    },
  };
}
