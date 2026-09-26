// `escalations` router (docs/tool-catalog.md, docs/design-brief.md §6 row 3): the open escalations of
// the world and their resolution by the firm. Resolving is dated in the world's simulated time,
// signed by the broker behind the session and recorded as an `ACTION` of the audit log.
import { z } from "zod";
import { OperationId } from "@legajo/shared";
import { brokerActor } from "../domain/common";
import { EscalationId } from "../domain/operations";
import { simNowOf } from "../lib/clock";
import { WorldInput, worldOf } from "./clock";
import { refusal } from "./errors";
import { escalationView } from "./operation-views";
import { firmProcedure, router } from "./trpc";

const ResolveInput = z.object({ operationId: OperationId, escalationId: EscalationId, resolution: z.string().trim().min(1).max(500) }).strict();

export const escalationsRouter = router({
  list: firmProcedure.input(WorldInput).query(async ({ ctx, input }) => {
    const clockId = await worldOf(ctx, input.clockId);
    const open = await ctx.deps.connector.operations.listOpenEscalationsByFirm(ctx.principal.firmId);
    return {
      clockId,
      escalations: open
        .filter((escalation) => escalation.clockId === clockId)
        .sort((a, b) => Date.parse(a.openedAtSim) - Date.parse(b.openedAtSim))
        .map(escalationView),
    };
  }),

  resolve: firmProcedure.input(ResolveInput).mutation(async ({ ctx, input }) => {
    const { brokerId } = ctx.principal;
    if (brokerId === undefined) throw refusal("FORBIDDEN", "this account has no broker row to sign with", "NO_BROKER");
    const data = ctx.deps.connector;
    const operation = await data.operations.getOperation(input.operationId);
    await ctx.firmScope.assertFirm(operation.firmId);
    const clock = await data.world.getClock(operation.clockId);
    const realNow = ctx.deps.wallClock();
    const atSim = simNowOf(clock, realNow.getTime()).toISOString();
    const by = brokerActor(brokerId);
    const escalation = await data.operations.resolveEscalation({ operationId: operation.operationId, escalationId: input.escalationId, atSim, by, resolution: input.resolution });
    await data.audit.record({
      firmId: operation.firmId,
      clockId: operation.clockId,
      operationId: operation.operationId,
      decision: "ACTION",
      action: "ESCALATION_RESOLVED",
      actor: by,
      trigger: "CONSOLE",
      refs: { operationId: operation.operationId, escalationId: escalation.escalationId, brokerId },
      atSim,
      atReal: realNow.toISOString(),
      correlationId: ctx.correlationId,
    });
    return { escalation: escalationView(escalation) };
  }),
});
