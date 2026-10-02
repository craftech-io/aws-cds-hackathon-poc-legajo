// Implementations of the `followups` tools behind `createToolHandler` (docs/tool-catalog.md):
// `schedule_followup` (followup.ts) and `estimate_delay_risk` (risk.ts). Operation, world and simulated
// now come from the scope of the call, never from the model's input; the timer ports (Scheduler and
// dispatcher) are the stage's (timers/stage.ts) or a test's.
import { ToolError, fail, ok } from "@legajo/shared";
import type { Implementations, ToolContext } from "../common/context";
import type { TimerPorts } from "../../timers/stage";
import { type FollowupInput, scheduleFollowup } from "./followup";
import { estimateDelayRisk } from "./risk";
import type { FOLLOWUPS_TOOLS } from "./schema";

function timerDepsOf(ctx: ToolContext<unknown>, ports: TimerPorts) {
  return { data: ctx.connector, scheduler: ports.scheduler, dispatcher: ports.dispatcher, realClock: ctx.wallClock, log: ctx.log };
}

export function followupsImplementations(ports: TimerPorts): Implementations<typeof FOLLOWUPS_TOOLS> {
  return {
    async schedule_followup(ctx) {
      const input: FollowupInput = { operationId: ctx.scope.operationId, party: ctx.input.party, atSim: ctx.input.atSim, reason: ctx.input.reason, nowSim: ctx.scope.nowSim };
      try {
        const scheduled = await scheduleFollowup(input, timerDepsOf(ctx, ports));
        await ctx.audit({
          decision: "ACTION",
          ruleIds: scheduled.adjustedBy,
          refs: { timerKey: scheduled.timerKey },
          detail: { party: input.party, reason: input.reason, requestedAtSim: input.atSim, scheduledForSim: scheduled.scheduledForSim, adjustedBy: [...scheduled.adjustedBy], schedule: scheduled.schedule },
        });
        return ok({ followupId: scheduled.followupId, scheduledForSim: scheduled.scheduledForSim, scheduledForText: scheduled.scheduledForText, adjustedBy: [...scheduled.adjustedBy] });
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        await ctx.audit({ decision: "DENY", ...(error.reason === undefined ? {} : { reason: error.reason }), detail: { party: input.party, reason: input.reason } });
        return fail(error.code, error.message, error.reason);
      }
    },

    async estimate_delay_risk(ctx) {
      const operation = await ctx.connector.operations.getOperation(ctx.scope.operationId);
      const [documents, settings] = await Promise.all([ctx.connector.documents.listDocuments(operation.operationId), ctx.connector.firms.getSettings(operation.firmId)]);
      const risk = estimateDelayRisk({ operation, documents, assumptions: settings.assumptions, nowSim: ctx.scope.nowSim });
      return ok({
        missing: [...risk.missing],
        hoursToEta: risk.hoursToEta,
        daysAtRisk: { ...risk.daysAtRisk },
        estimatedCostUsd: { ...risk.estimatedCostUsd },
        assumptions: risk.assumptions.map((assumption) => ({ ...assumption })),
        text: risk.text,
      });
    },
  };
}
