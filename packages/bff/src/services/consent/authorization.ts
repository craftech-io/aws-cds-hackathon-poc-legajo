// `authorize_supplier_contact` (docs/tool-catalog.md, FL-003, FL-006): the importer's permission for the
// agent to write to one supplier (`Parties/IMP#…/AUTH#<supplierId>`), the first half of
// `CP-SUPPLIER-AUTH`. The console (or QA) records it on or off with the broker who registered it, at the
// world's simulated now, appending its dated history so `PolicyAudit` can rebuild it at any instant.
// Setting the state it already has writes nothing. The importer and the supplier must be of the
// caller's firm and of the same world.
import { AuthorizationSetInput, ToolError } from "@legajo/shared";
import type { SupplierAuthorization } from "../../domain/parties";
import { createDirectHandler } from "../operations-admin/handler-kit";
import type { ServiceDeps } from "../operations-admin/ports";

function authorizationView(authorization: SupplierAuthorization) {
  return {
    importerId: authorization.importerId,
    supplierId: authorization.supplierId,
    authorized: authorization.authorized,
    ...(authorization.authorizedAt === undefined ? {} : { authorizedAt: authorization.authorizedAt }),
    ...(authorization.brokerId === undefined ? {} : { brokerId: authorization.brokerId }),
    ...(authorization.revokedAt === undefined ? {} : { revokedAt: authorization.revokedAt }),
  };
}

export function authorizeSupplierContactHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "authorize_supplier_contact",
      input: AuthorizationSetInput,
      callers: ["CONSOLE", "QA"],
      async run(ctx) {
        const { input } = ctx;
        const { parties } = ctx.connector;
        const importer = await parties.getImporter(input.importerId);
        await ctx.fence(importer.firmId, { kind: "importer", id: importer.importerId });
        const supplier = await parties.getSupplier(input.supplierId);
        await ctx.fence(supplier.firmId, { kind: "supplier", id: supplier.supplierId });
        if (supplier.clockId !== importer.clockId || (input.clockId !== undefined && input.clockId !== importer.clockId)) {
          throw new ToolError("INVALID", "the importer and the supplier are not of the same world", "WORLD_MISMATCH");
        }
        const current = await parties.getAuthorization(importer.importerId, supplier.supplierId);
        if (current !== undefined && current.authorized === input.authorized) return { ...authorizationView(current), changed: false };
        const world = await ctx.world(importer.clockId);
        const authorization = await parties.setAuthorization({
          importerId: importer.importerId,
          supplierId: supplier.supplierId,
          authorized: input.authorized,
          ...(ctx.caller.brokerId === undefined ? {} : { brokerId: ctx.caller.brokerId }),
          atSim: world.atSim,
          atReal: ctx.now().toISOString(),
          by: ctx.actor,
        });
        await ctx.audit({
          firmId: importer.firmId,
          decision: "ACTION",
          action: input.authorized ? "SUPPLIER_CONTACT_AUTHORIZED" : "SUPPLIER_CONTACT_REVOKED",
          clockId: importer.clockId,
          atSim: world.atSim,
          refs: { importerId: importer.importerId, supplierId: supplier.supplierId },
        });
        return { ...authorizationView(authorization), changed: true };
      },
    },
    deps,
  );
}
