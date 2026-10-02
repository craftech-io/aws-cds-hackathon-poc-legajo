// `upsert_party` (docs/tool-catalog.md, FL-001, FL-004, FL-123): the registry of the caller's world, in
// one handler with three shapes, each the console's own input (`packages/shared/src/console-inputs.ts`):
//
//   IMPORTER   `registry.importers.upsert` (importers.ts)
//   SUPPLIER   `registry.suppliers.upsert` (suppliers.ts)
//   CONTACT    `registry.contacts.upsert` (suppliers.ts)
//
// A change is `ACTION <PARTY>_CREATED` / `<PARTY>_UPDATED` / `CONTACT_ADDED`. A refused address or phone
// is audited before the refusal goes back: `DENY CP-RECIPIENT-FENCE` for an address outside the
// recipient fence or anything but synthetic data in a guest world (`RECIPIENT_NOT_ALLOWED`), `DENY` with
// the reason for a claim another party holds (`CONFLICT`). Nothing is written when something is refused.
import { z } from "zod";
import { ContactUpsertInput, ImporterUpsertInput, type RuleId, SupplierUpsertInput, ToolError } from "@legajo/shared";
import { type DirectContext, createDirectHandler } from "../operations-admin/handler-kit";
import type { ServiceDeps } from "../operations-admin/ports";
import { ADDRESS_REASON } from "./address-rules";
import { importerView, upsertImporter } from "./importers";
import { FenceRefusal, type SupplierUpsert, contactView, supplierView, upsertContact, upsertSupplier } from "./suppliers";

export const UpsertPartyInput = z.discriminatedUnion("party", [
  z.object({ party: z.literal("IMPORTER"), data: ImporterUpsertInput }).strict(),
  z.object({ party: z.literal("SUPPLIER"), data: SupplierUpsertInput }).strict(),
  z.object({ party: z.literal("CONTACT"), data: ContactUpsertInput }).strict(),
]);
type UpsertInput = z.output<typeof UpsertPartyInput>;

const FENCE_RULE: RuleId = "CP-RECIPIENT-FENCE";

/** Which refusals the audit keeps, and under which rule. */
function refusalOf(error: unknown): { readonly ruleIds: readonly RuleId[]; readonly reason: string } | undefined {
  if (error instanceof FenceRefusal) return { ruleIds: [FENCE_RULE], reason: error.fenceReason };
  if (!(error instanceof ToolError)) return undefined;
  if (error.code === "RECIPIENT_NOT_ALLOWED") return { ruleIds: [FENCE_RULE], reason: error.reason ?? ADDRESS_REASON.GUEST_SYNTHETIC_ONLY };
  if (error.code === "CONFLICT") return { ruleIds: [], reason: "ADDRESS_CLAIMED" };
  return undefined;
}

async function auditRefusal(ctx: DirectContext<UpsertInput>, firmId: string, error: unknown): Promise<void> {
  const refusal = refusalOf(error);
  if (refusal === undefined) return;
  await ctx.audit({
    firmId,
    decision: "DENY",
    action: `${ctx.input.party}_UPSERT_REFUSED`,
    ruleIds: refusal.ruleIds,
    reason: refusal.reason,
    ...(ctx.input.data.clockId === undefined ? {} : { clockId: ctx.input.data.clockId }),
    detail: { party: ctx.input.party },
  });
}

function supplierAnswer(result: SupplierUpsert) {
  const contacts = result.existing === undefined ? result.contacts : [result.existing];
  return { party: "SUPPLIER" as const, created: result.created, supplier: supplierView(result.supplier), contacts: contacts.map(contactView) };
}

async function apply(ctx: DirectContext<UpsertInput>, deps: ServiceDeps, firmId: string) {
  const { input } = ctx;
  switch (input.party) {
    case "IMPORTER": {
      const { importer, created } = await upsertImporter(ctx, deps, firmId, input.data);
      await ctx.audit({ firmId, decision: "ACTION", action: created ? "IMPORTER_CREATED" : "IMPORTER_UPDATED", clockId: importer.clockId, refs: { importerId: importer.importerId } });
      return { party: "IMPORTER" as const, created, importer: importerView(importer) };
    }
    case "SUPPLIER": {
      const result = await upsertSupplier(ctx, deps, firmId, input.data);
      await ctx.audit({
        firmId,
        decision: "ACTION",
        action: result.created ? "SUPPLIER_CREATED" : "SUPPLIER_UPDATED",
        clockId: result.supplier.clockId,
        refs: { supplierId: result.supplier.supplierId },
        detail: { contactsAdded: result.contacts.length },
      });
      return supplierAnswer(result);
    }
    case "CONTACT": {
      const result = await upsertContact(ctx, deps, input.data);
      const [added] = result.contacts;
      if (added !== undefined) await ctx.audit({ firmId, decision: "ACTION", action: "CONTACT_ADDED", clockId: result.supplier.clockId, refs: { supplierId: result.supplier.supplierId, contactId: added.contactId } });
      return { ...supplierAnswer(result), party: "CONTACT" as const };
    }
  }
}

export function upsertPartyHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "upsert_party",
      input: UpsertPartyInput,
      callers: ["CONSOLE", "QA"],
      async run(ctx) {
        const firmId = ctx.caller.firmId;
        if (firmId === undefined) throw new ToolError("FORBIDDEN", "the registry is changed for a firm", "NO_FIRM");
        try {
          return await apply(ctx, deps, firmId);
        } catch (error) {
          await auditRefusal(ctx, firmId, error);
          throw error;
        }
      },
    },
    deps,
  );
}
