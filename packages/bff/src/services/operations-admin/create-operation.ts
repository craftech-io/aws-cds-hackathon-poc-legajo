// `create_operation` (docs/tool-catalog.md, FL-005; ADR-0015 §4): "Nueva operación" by number.
//
//   1. the world: the one named or the firm's only one (`firm-qa` names it), fenced to the caller;
//   2. the operation id of that number in that world (`op-4479`, `op-4479-g03` in a guest world) must be
//      free (`CONFLICT`, nothing written);
//   3. the platform's master data for this firm (`PlatformMock`, SigV4): `NOT_FOUND` when it has none;
//      its importer and supplier must be parties of this firm and this world;
//   4. a guest world spends one `NEW_OPERATIONS` (10 a day, real time): `QUOTA_EXCEEDED {kind,
//      resetsAtReal}` and nothing written past it;
//   5. the operation, its three documents (`MISSING` or what the platform brings) and its thread
//      address `op-<number>-<tag>@…` with the HMAC tag of (number, clock, epoch), claimed with `ADDR#`
//      in the same transaction; dossier `OPEN`, control `AGENT`, opened at the world's simulated now;
//   6. `schedule_milestones`: the five `TIMER#MILESTONE#` (a milestone already past fires once);
//   7. `ACTION OPERATION_CREATED`.
import { z } from "zod";
import { ClockId, OperationNumber, ToolError, computeThreadTag, operationId as baseOperationId, threadAddress } from "@legajo/shared";
import type { DocStatus, DocType } from "@legajo/shared";
import { scheduleMilestones } from "../../milestones/schedule";
import { consumeQuota } from "../../worlds/guest-quotas";
import { createDirectHandler } from "./handler-kit";
import type { ServiceDeps } from "./ports";
import { operationIdInWorld, registryWorld } from "./world-scope";

/** `operations.create`: the number, and the world for a firm with several. */
export const CreateOperationInput = z.object({ operationNumber: OperationNumber, clockId: ClockId.optional() }).strict();

export function createOperationHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "create_operation",
      input: CreateOperationInput,
      callers: ["CONSOLE", "QA"],
      async run(ctx) {
        const { input } = ctx;
        const firmId = ctx.caller.firmId;
        if (firmId === undefined) throw new ToolError("FORBIDDEN", "an operation is created for a firm", "NO_FIRM");
        const clockId = await registryWorld(ctx, firmId, input.clockId);
        const operationId = operationIdInWorld(input.operationNumber, clockId);
        if ((await ctx.connector.operations.findOperation(operationId)) !== undefined) throw new ToolError("CONFLICT", "that operation is already in the console", "OPERATION_EXISTS");

        const platform = await deps.platform.get(firmId, input.operationNumber);
        const { parties } = ctx.connector;
        const [importer, supplier] = await Promise.all([parties.findImporter(platform.importerId), parties.findSupplier(platform.supplierId)]);
        if (importer === undefined || supplier === undefined || importer.firmId !== firmId || supplier.firmId !== firmId || importer.clockId !== clockId || supplier.clockId !== clockId) {
          throw new ToolError("INVALID", "the importer or the supplier of that operation is not registered in this world", "PARTIES_NOT_REGISTERED");
        }

        await consumeQuota({ client: deps.quotaTable, now: deps.wallClock, log: ctx.log }, clockId, "NEW_OPERATIONS");

        const world = await ctx.world(clockId);
        const { worldEpoch } = world.clock;
        const threadTag = await computeThreadTag(deps.keys.threadKey(), { operationNumber: input.operationNumber, clockId, worldEpoch });
        const address = threadAddress(input.operationNumber, threadTag);
        const atReal = ctx.now().toISOString();
        const operation = await ctx.connector.operations.createOperation({
          operationId,
          operationNumber: input.operationNumber,
          firmId,
          clockId,
          worldEpoch,
          importerId: importer.importerId,
          supplierId: supplier.supplierId,
          templateOperation: baseOperationId(input.operationNumber),
          vessel: platform.vessel,
          carrier: platform.carrier,
          regime: platform.regime,
          portOfLoading: platform.port,
          eta: platform.eta,
          invoiceNumber: platform.invoiceNumber,
          incoterm: platform.incoterm,
          incotermPlace: platform.incotermPlace,
          dossierStatus: "OPEN",
          control: "AGENT",
          threadAddress: address,
          threadTag,
          openedAtSim: world.atSim,
          created: { atSim: world.atSim, atReal, by: ctx.actor },
          etaSource: "PLATFORM",
          documents: platform.documents as Partial<Record<DocType, DocStatus>>,
          threadClaimHash: deps.keys.emailHash(address),
        });

        const milestones = await scheduleMilestones({ operation, correlationId: ctx.correlationId }, deps.timers);
        await ctx.audit({
          firmId,
          decision: "ACTION",
          action: "OPERATION_CREATED",
          clockId,
          operationId,
          atSim: world.atSim,
          refs: { importerId: importer.importerId, supplierId: supplier.supplierId },
          detail: { operationNumber: input.operationNumber, scheduled: [...milestones.scheduled], dispatched: [...milestones.dispatched] },
        });
        return { operationId, operationNumber: input.operationNumber, clockId, dossierStatus: operation.dossierStatus, milestones: { scheduled: milestones.scheduled, dispatched: milestones.dispatched } };
      },
    },
    deps,
  );
}
