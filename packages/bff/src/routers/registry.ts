// `registry` router (docs/tool-catalog.md, docs/design-brief.md §6; FL-001, FL-003, FL-004, FL-006,
// FL-088, FL-123): the importers of the world with their WhatsApp opt-in and supplier authorizations,
// and the suppliers with their contacts. Phones and emails are masked. The consent and authorization
// shown is the one in force now (the dated history stays in the rows for `PolicyAudit`).
//
// The changes run the direct handlers of services/consent and services/contacts with the caller the
// principal stands for: `ADDR#` unique per phone and address (`CONFLICT`), the recipient fence and, in a
// guest world, only synthetic phones and mailboxes (`RECIPIENT_NOT_ALLOWED`, audited `DENY`). Inputs are
// the shared ones (packages/shared/src/console-inputs.ts). `supplierBehaviour.set` is the simulated
// supplier's behaviour (FL-088), for the supplier or for one of its operations.
import {
  AuthorizationSetInput,
  ConsentRecordInput,
  ConsentRevokeInput,
  ContactConfirmInput,
  ContactUpsertInput,
  ImporterUpsertInput,
  type SupplierBehaviour,
  SupplierBehaviourSetInput,
  SupplierUpsertInput,
} from "@legajo/shared";
import type { Consent, SupplierAuthorization } from "../domain/parties";
import { actorOfCaller } from "../services/operations-admin/handler-kit";
import { callerOf, runDirect } from "./console-services";
import { WorldInput, worldOf } from "./clock";
import { refusal } from "./errors";
import { importerView, supplierView } from "./operation-views";
import { type FirmContext, firmProcedure, router } from "./trpc";

function consentView(consent: Consent | undefined) {
  if (consent === undefined) return { status: "NONE" as const };
  if (consent.revokedAt !== undefined) return { status: "REVOKED" as const, revokedAt: consent.revokedAt };
  return { status: "GRANTED" as const, grantedAt: consent.grantedAt, medium: consent.medium, textVersion: consent.textVersion };
}

function authorizationView(authorization: SupplierAuthorization) {
  return { supplierId: authorization.supplierId, authorized: authorization.authorized, ...(authorization.authorizedAt === undefined ? {} : { authorizedAt: authorization.authorizedAt }) };
}

interface BehaviourChange {
  readonly supplierId: string;
  readonly behaviour: SupplierBehaviour;
  readonly operationId?: string;
}

/** The simulated supplier's behaviour for the supplier, or only for one of its operations (`simBehaviour`). */
async function setBehaviour(ctx: FirmContext, input: BehaviourChange) {
  const data = ctx.deps.connector;
  const supplier = await data.parties.getSupplier(input.supplierId);
  await ctx.firmScope.assertFirm(supplier.firmId);
  const operation = input.operationId === undefined ? undefined : await data.operations.getOperation(input.operationId);
  if (operation !== undefined && operation.supplierId !== supplier.supplierId) throw refusal("INVALID", "that operation is not of this supplier", "OPERATION_NOT_OF_SUPPLIER");
  if (operation === undefined) await data.parties.updateSupplier(supplier.supplierId, { behaviour: input.behaviour });
  else await data.operations.updateOperation(operation.operationId, { simBehaviour: input.behaviour });
  await data.audit.record({
    firmId: supplier.firmId,
    decision: "ACTION",
    action: "SUPPLIER_BEHAVIOUR_SET",
    actor: actorOfCaller(callerOf(ctx.principal)),
    clockId: supplier.clockId,
    refs: { supplierId: supplier.supplierId, ...(operation === undefined ? {} : { operationId: operation.operationId }), ...(ctx.principal.brokerId === undefined ? {} : { brokerId: ctx.principal.brokerId }) },
    ...(operation === undefined ? {} : { operationId: operation.operationId }),
    atReal: ctx.deps.wallClock().toISOString(),
    correlationId: ctx.correlationId,
    detail: { behaviour: input.behaviour, scope: operation === undefined ? "SUPPLIER" : "OPERATION" },
  });
  return { supplierId: supplier.supplierId, behaviour: input.behaviour, ...(operation === undefined ? {} : { operationId: operation.operationId }) };
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
    upsert: firmProcedure.input(ImporterUpsertInput).mutation(({ ctx, input }) => runDirect(ctx, "upsert_party", { party: "IMPORTER", data: input })),
  }),

  consent: router({
    record: firmProcedure.input(ConsentRecordInput).mutation(({ ctx, input }) => runDirect(ctx, "record_consent", input)),
    revoke: firmProcedure.input(ConsentRevokeInput).mutation(({ ctx, input }) => runDirect(ctx, "revoke_consent", input)),
  }),

  authorization: router({
    set: firmProcedure.input(AuthorizationSetInput).mutation(({ ctx, input }) => runDirect(ctx, "authorize_supplier_contact", input)),
  }),

  suppliers: router({
    list: firmProcedure.input(WorldInput).query(async ({ ctx, input }) => {
      const data = ctx.deps.connector;
      const clockId = await worldOf(ctx, input.clockId);
      const suppliers = await data.parties.listSuppliers(ctx.principal.firmId, { clockId });
      const rows = await Promise.all(suppliers.map(async (supplier) => supplierView(supplier, await data.parties.listContacts(supplier.supplierId))));
      return { clockId, suppliers: rows };
    }),
    upsert: firmProcedure.input(SupplierUpsertInput).mutation(({ ctx, input }) => runDirect(ctx, "upsert_party", { party: "SUPPLIER", data: input })),
  }),

  contacts: router({
    upsert: firmProcedure.input(ContactUpsertInput).mutation(({ ctx, input }) => runDirect(ctx, "upsert_party", { party: "CONTACT", data: input })),
    confirm: firmProcedure.input(ContactConfirmInput).mutation(({ ctx, input }) => runDirect(ctx, "confirm_supplier_contact", input)),
  }),

  supplierBehaviour: router({
    set: firmProcedure.input(SupplierBehaviourSetInput).mutation(({ ctx, input }) => setBehaviour(ctx, input)),
  }),
});
