// `Parties`, importer side: the importer and its phone claim (`ADDR#<phoneHash>`, conditional, in
// the same transaction), the WhatsApp opt-in and the supplier-contact authorizations, both with
// their dated histories appended in the same write as the state they change.
import { ConnectorError } from "@legajo/shared";
import { AuthorizationEvent, Consent, ConsentEvent, Importer, Supplier, SupplierAuthorization } from "../../domain/parties";
import type { TableName } from "../../lib/resource";
import { expectedIndexAttributes } from "../item-shape";
import { AUTH_PREFIX, authorizationKey, consentKey, importerKey, importerPartition, registryKey, sortNameOf, supplierKey } from "../keys";
import type { IdentityLookup, PartiesPort } from "../ports";
import type { TransactOp } from "../table-client";
import { claimRow, releaseClaimOp } from "./address-claims";
import { buildRow, checked, checkPatch, createRow, defined, nowIso, optionalEntity, parseEntities, pinnedVersion, requireEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "Parties";

type ImporterMethods = Pick<
  PartiesPort,
  | "getImporter"
  | "findImporter"
  | "findImporterByPhoneHash"
  | "listImporters"
  | "createImporter"
  | "updateImporter"
  | "getConsent"
  | "grantConsent"
  | "revokeConsent"
  | "getAuthorization"
  | "listAuthorizations"
  | "setAuthorization"
>;

export function importersRepo(ctx: RepoContext): ImporterMethods {
  const { client } = ctx;

  const getImporter = async (importerId: string): Promise<Importer> =>
    requireEntity(Importer, "Importer", await client.get(TABLE, importerKey(importerId)), TABLE, `importer ${importerId}`);

  return {
    getImporter,

    async findImporter(importerId) {
      return optionalEntity(Importer, "Importer", await client.get(TABLE, importerKey(importerId)), TABLE);
    },

    // Two rows, never one: with a shared phone the index would hand whichever importer it returns
    // first the other one's session. `ADDR#` prevents it at write time; this refuses to guess.
    async findImporterByPhoneHash(phoneHash): Promise<IdentityLookup<Importer>> {
      const rows = await client.query(TABLE, { index: "GSI1", hashValue: phoneHash, filter: { equals: { entity: "Importer" } }, limit: 2 });
      const importers = parseEntities(Importer, "Importer", rows, TABLE);
      if (importers.length === 0) return { status: "NONE" };
      const [first] = importers;
      if (importers.length === 1 && first) return { status: "UNIQUE", value: first };
      return { status: "AMBIGUOUS", ids: importers.map((importer) => importer.importerId) };
    },

    async listImporters(firmId, options = {}) {
      const rows = await client.query(TABLE, {
        index: "GSI3",
        hashValue: registryKey(firmId, "IMP"),
        filter: { equals: { entity: "Importer", ...(options.clockId === undefined ? {} : { clockId: options.clockId }) } },
      });
      return parseEntities(Importer, "Importer", rows, TABLE);
    },

    async createImporter(importer) {
      const built = buildRow(ctx, TABLE, Importer, "Importer", importerKey(importer.importerId), importer, { gsi: expectedIndexAttributes("Importer", importer) });
      const claim = claimRow(ctx, { addressHash: importer.phoneHash, kind: "PHONE", ownerType: "IMPORTER", ownerId: importer.importerId, firmId: importer.firmId, clockId: importer.clockId });
      await client.transact([
        { op: "put", table: TABLE, item: built.item, condition: { ifNotExists: true } },
        { op: "put", table: TABLE, item: claim, condition: { ifNotExists: true } },
      ]);
      return built.value;
    },

    async updateImporter(importerId, patch, expectedVersion) {
      const key = importerKey(importerId);
      const fields = checkPatch(Importer, patch, TABLE, `importer ${importerId}`);
      const current = await getImporter(importerId);
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw new ConnectorError("CONFLICT", `importer ${importerId} changed`, TABLE);
      const set = { ...fields, ...(typeof fields.name === "string" ? { sortName: sortNameOf(fields.name) } : {}) };
      const phoneHash = typeof fields.phoneHash === "string" ? fields.phoneHash : undefined;
      if (phoneHash === undefined || phoneHash === current.phoneHash) {
        return updateRow(ctx, TABLE, Importer, "Importer", key, { set }, { condition: { ifVersion: current.version } });
      }
      // The new phone must be free, the old claim is released, and the importer must not have
      // changed in between: all in one transaction.
      const claim = claimRow(ctx, { addressHash: phoneHash, kind: "PHONE", ownerType: "IMPORTER", ownerId: importerId, firmId: current.firmId, clockId: current.clockId });
      const ops: TransactOp[] = [
        { op: "update", table: TABLE, key, spec: { set }, updatedAt: nowIso(ctx), options: { condition: { ifVersion: current.version } } },
        { op: "put", table: TABLE, item: claim, condition: { ifNotExists: true } },
        releaseClaimOp(current.phoneHash, importerId),
      ];
      await client.transact(ops);
      return getImporter(importerId);
    },

    async getConsent(importerId) {
      return optionalEntity(Consent, "Consent", await client.get(TABLE, consentKey(importerId)), TABLE);
    },

    async grantConsent(grant) {
      const importer = await getImporter(grant.importerId);
      const event = checked(ConsentEvent, TABLE, defined({ atSim: grant.atSim, atReal: grant.atReal, by: grant.by, reason: grant.reason, action: "GRANTED", medium: grant.medium, textVersion: grant.textVersion }));
      const key = consentKey(grant.importerId);
      const existing = await client.get(TABLE, key);
      const state = { grantedAt: grant.atSim, medium: grant.medium, textVersion: grant.textVersion };
      if (existing === undefined) {
        return createRow(ctx, TABLE, Consent, "Consent", key, { importerId: importer.importerId, firmId: importer.firmId, clockId: importer.clockId, channel: "WHATSAPP", ...state, history: [event] });
      }
      const version = typeof existing.version === "number" ? existing.version : 0;
      return updateRow(ctx, TABLE, Consent, "Consent", key, { set: { ...state, revokedAt: null, revokeReason: null }, append: { history: [event] } }, { condition: { ifVersion: version } });
    },

    async revokeConsent(revocation) {
      const key = consentKey(revocation.importerId);
      const version = await pinnedVersion(ctx, TABLE, key, undefined, `consent of ${revocation.importerId}`);
      const event = checked(ConsentEvent, TABLE, defined({ atSim: revocation.atSim, atReal: revocation.atReal, by: revocation.by, reason: revocation.reason, action: "REVOKED" }));
      return updateRow(ctx, TABLE, Consent, "Consent", key, { set: { revokedAt: revocation.atSim, revokeReason: revocation.reason }, append: { history: [event] } }, { condition: { ifVersion: version } });
    },

    async getAuthorization(importerId, supplierId) {
      return optionalEntity(SupplierAuthorization, "SupplierAuthorization", await client.get(TABLE, authorizationKey(importerId, supplierId)), TABLE);
    },

    async listAuthorizations(importerId) {
      const rows = await client.query(TABLE, { hashValue: importerPartition(importerId), range: { prefix: AUTH_PREFIX } });
      return parseEntities(SupplierAuthorization, "SupplierAuthorization", rows, TABLE);
    },

    // Seed invariant 9: an authorization always points to a supplier of the importer's own firm.
    async setAuthorization(change) {
      const importer = await getImporter(change.importerId);
      const supplier = requireEntity(Supplier, "Supplier", await client.get(TABLE, supplierKey(change.supplierId)), TABLE, `supplier ${change.supplierId}`);
      if (supplier.firmId !== importer.firmId) throw new ConnectorError("VALIDATION", `supplier ${change.supplierId} is not of firm ${importer.firmId}`, TABLE);
      const event = checked(AuthorizationEvent, TABLE, defined({ atSim: change.atSim, atReal: change.atReal, by: change.by, reason: change.reason, action: change.authorized ? "AUTHORIZED" : "REVOKED" }));
      const state = change.authorized
        ? { authorized: true, authorizedAt: change.atSim, brokerId: change.brokerId ?? null, revokedAt: null }
        : { authorized: false, revokedAt: change.atSim };
      const key = authorizationKey(change.importerId, change.supplierId);
      const existing = await client.get(TABLE, key);
      if (existing === undefined) {
        const fields = defined(Object.fromEntries(Object.entries(state).map(([name, value]) => [name, value ?? undefined])));
        return createRow(ctx, TABLE, SupplierAuthorization, "SupplierAuthorization", key, { importerId: importer.importerId, supplierId: supplier.supplierId, firmId: importer.firmId, clockId: importer.clockId, ...fields, history: [event] });
      }
      const version = typeof existing.version === "number" ? existing.version : 0;
      return updateRow(ctx, TABLE, SupplierAuthorization, "SupplierAuthorization", key, { set: state, append: { history: [event] } }, { condition: { ifVersion: version } });
    },
  };
}
