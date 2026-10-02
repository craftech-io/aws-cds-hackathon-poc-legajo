// Implementations of the `handoff` tools behind `createToolHandler` (docs/tool-catalog.md):
// `escalate_to_broker` (escalations/escalate.ts: one open escalation per reason, the firm's email with
// its caps, `legajo_escalado` with `notifyImporter`) and `request_approval` (approval.ts: never
// approves). Operation, firm and simulated now come from the scope of the call; the pipeline is the
// stage's (outbound/stage.ts) or a test's.
import { type AgentMode, ToolError, fail, ok } from "@legajo/shared";
import { escalate } from "../../escalations/escalate";
import type { OutboundSender } from "../../escalations/ports";
import type { Implementations, ToolContext } from "../common/context";
import { actorOf } from "../common/context";
import { requestApproval } from "./approval";
import type { HANDOFF_TOOLS } from "./schema";

export interface HandoffPorts {
  /** The outbound pipeline (`sendOutbound` over the stage's `OutboundDeps`). */
  readonly send: OutboundSender;
  /** `REAL` in the stage, `SCRIPTED` in the local flows (the KPI row says which). */
  readonly agentMode: AgentMode;
}

function turnOf(ctx: ToolContext<unknown>) {
  const { principal } = ctx;
  return principal.kind === "SESSION" ? { trigger: principal.trigger, turnId: principal.turnId } : {};
}

async function refused(ctx: ToolContext<unknown>, error: unknown, detail: Readonly<Record<string, unknown>>) {
  if (!(error instanceof ToolError)) throw error;
  await ctx.audit({ decision: "DENY", ...(error.reason === undefined ? {} : { reason: error.reason }), detail });
  return fail(error.code, error.message, error.reason);
}

export function handoffImplementations(ports: HandoffPorts): Implementations<typeof HANDOFF_TOOLS> {
  return {
    async escalate_to_broker(ctx) {
      const operation = await ctx.connector.operations.getOperation(ctx.scope.operationId);
      const escalated = await escalate(
        {
          operation,
          reason: ctx.input.reason,
          summary: ctx.input.summary,
          ...(ctx.input.notifyImporter === undefined ? {} : { notifyImporter: ctx.input.notifyImporter }),
          actor: actorOf(ctx.principal),
          atSim: ctx.scope.nowSim,
          ...turnOf(ctx),
          correlationId: ctx.correlationId,
        },
        { data: ctx.connector, send: ports.send, wallClock: ctx.wallClock, log: ctx.log },
      );
      await ctx.audit({
        decision: "ACTION",
        action: escalated.created ? "ESCALATED" : "ESCALATION_EXISTS",
        reason: ctx.input.reason,
        refs: { escalationId: escalated.escalation.escalationId },
        detail: { reason: ctx.input.reason, created: escalated.created, firmEmail: escalated.firmEmail, ...(escalated.importerNotice === undefined ? {} : { importerNotice: escalated.importerNotice }) },
      });
      return ok({ escalationId: escalated.escalation.escalationId, emailSent: escalated.emailSent });
    },

    async request_approval(ctx) {
      try {
        const requested = await requestApproval(
          { operationId: ctx.scope.operationId, summary: ctx.input.summary, actor: actorOf(ctx.principal), nowSim: ctx.scope.nowSim, correlationId: ctx.correlationId, ...turnOf(ctx) },
          { data: ctx.connector, send: ports.send, agentMode: ports.agentMode, wallClock: ctx.wallClock, log: ctx.log },
        );
        if (requested.changed) await ctx.audit({ decision: "ACTION", action: "READY_FOR_REVIEW", detail: { email: requested.email ?? null } });
        return ok({ dossierStatus: "READY_FOR_REVIEW" });
      } catch (error) {
        return refused(ctx, error, { dossierStatus: (await ctx.connector.operations.getOperation(ctx.scope.operationId)).dossierStatus });
      }
    },
  };
}
