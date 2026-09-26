// `registry` router (docs/tool-catalog.md, docs/design-brief.md §6): the importers of the world with
// their WhatsApp opt-in and supplier authorizations, and the suppliers with their contacts. Phones
// and emails are masked. The consent and authorization shown is the one in force now (the dated
// history stays in the rows for `PolicyAudit`).
import type { Consent, SupplierAuthorization } from "../domain/parties";
import { WorldInput, worldOf } from "./clock";
import { importerView, supplierView } from "./operation-views";
import { firmProcedure, router } from "./trpc";

function consentView(consent: Consent | undefined) {
  if (consent === undefined) return { status: "NONE" as const };
  if (consent.revokedAt !== undefined) return { status: "REVOKED" as const, revokedAt: consent.revokedAt };
  return { status: "GRANTED" as const, grantedAt: consent.grantedAt, medium: consent.medium, textVersion: consent.textVersion };
}

function authorizationView(authorization: SupplierAuthorization) {
  return { supplierId: authorization.supplierId, authorized: authorization.authorized, ...(authorization.authorizedAt === undefined ? {} : { authorizedAt: authorization.authorizedAt }) };
}

export const registryRouter = router({
  importers: router({
    list: firmProcedure.input(WorldInput).query(async ({ ctx, input }) => {
      const data = ctx.deps.connector;
      const clockId = await worldOf(ctx, input.clockId);
      const importers = await data.parties.listImporters(ctx.principal.firmId, { clockId });
      const rows = await Promise.all(
        importers.map(async (importer) => {
          const [consent, authorizations] = await Promise.all([data.parties.getConsent(importer.importerId), data.parties.listAuthorizations(importer.importerId)]);
          return { ...importerView(importer), consent: consentView(consent), authorizations: authorizations.map(authorizationView) };
        }),
      );
      return { clockId, importers: rows };
    }),
  }),

  suppliers: router({
    list: firmProcedure.input(WorldInput).query(async ({ ctx, input }) => {
      const data = ctx.deps.connector;
      const clockId = await worldOf(ctx, input.clockId);
      const suppliers = await data.parties.listSuppliers(ctx.principal.firmId, { clockId });
      const rows = await Promise.all(suppliers.map(async (supplier) => supplierView(supplier, await data.parties.listContacts(supplier.supplierId))));
      return { clockId, suppliers: rows };
    }),
  }),
});
