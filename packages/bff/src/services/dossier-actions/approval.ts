// `approve_dossier` and `reopen_dossier` (docs/tool-catalog.md; ADR-0010; FL-073, FL-075, FL-076). Only a
// person approves: role `BROKER`, or `GUEST` in its own guest firm (an `ANALYST` gets 403 and `DENY
// ROLE_NOT_ALLOWED`, FL-075); the router adds the recent login (`recentLoginProcedure`, ≤ 15 min).
//
//   approve   `READY_FOR_REVIEW` → `APPROVED` with `approvedBy` and `approvedAtSim` (the world's simulated
//             now), only with the three documents `VALID` (`NOT_COMPLETE`); the pending milestones
//             and follow-ups are cancelled except `ARRIVAL`; `OUTBOUND_SEND` with `legajo_aprobado`
//             signed by the broker; `ACTION APPROVED` with `brokerId`; the human action counted.
//   reopen    `APPROVED` → `REOPENED` with its reason: the agent may ask for documents again and, once
//             complete, the dossier goes back to `READY_FOR_REVIEW` for a new approval.
//             `ACTION REOPENED`.
//
// Any other status is `CONFLICT` with the status it is in; nothing is written.
import { DossierApproveInput, DossierReopenInput, ToolError } from "@legajo/shared";
import type { Timer } from "../../domain/timers";
import { closeOperationTimers } from "../../timers/timers";
import { approvalNoticeSend, newConsoleEventId } from "../conversation-control/outbound-send";
import { actingBroker, createDirectHandler } from "../operations-admin/handler-kit";
import { countHumanAction } from "../operations-admin/human-actions";
import type { ServiceDeps } from "../operations-admin/ports";
import { fencedOperation } from "../operations-admin/world-scope";
import { isComplete } from "./completion";

/** Who may approve or reopen (ADR-0010; a guest only inside its own firm, which the fence enforces). */
export const APPROVER_ROLES = ["BROKER", "GUEST"] as const;

/** What an approval leaves armed: the arrival milestone and every timer that is not a reminder. */
export function keptAfterApproval(timer: Pick<Timer, "kind" | "timerId">): boolean {
  if (timer.kind === "MILESTONE") return timer.timerId === "ARRIVAL";
  return timer.kind !== "FOLLOWUP_DUE";
}

export function approveDossierHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "approve_dossier",
      input: DossierApproveInput,
      callers: ["CONSOLE", "QA"],
      roles: APPROVER_ROLES,
      async run(ctx) {
        const brokerId = actingBroker(ctx.caller);
        const operation = await fencedOperation(ctx, ctx.input.operationId);
        if (operation.dossierStatus !== "READY_FOR_REVIEW") throw new ToolError("CONFLICT", `the dossier is ${operation.dossierStatus}, not ready for review`, "NOT_READY_FOR_REVIEW");
        const documents = await ctx.connector.documents.listDocuments(operation.operationId);
        if (!isComplete(documents.map((document) => document.status))) throw new ToolError("NOT_COMPLETE", "the three documents must be valid before approving", "NOT_COMPLETE");
        const { atSim } = await ctx.world(operation.clockId);
        const approved = await ctx.connector.operations.transitionDossier({
          operationId: operation.operationId,
          to: "APPROVED",
          approvedBy: brokerId,
          atSim,
          atReal: ctx.now().toISOString(),
          by: ctx.actor,
          expectedVersion: operation.version,
        });
        const cancelled = await closeOperationTimers({ operationId: operation.operationId, atSim, reason: "DOSSIER_APPROVED", keep: keptAfterApproval }, deps.timers);
        await deps.events.enqueue(
          approvalNoticeSend({ operationId: operation.operationId, clockId: operation.clockId, firmId: operation.firmId, eventAtSim: atSim, correlationId: ctx.correlationId, eventId: newConsoleEventId(ctx.now().getTime()), author: ctx.actor, operationNumber: operation.operationNumber }),
        );
        await ctx.audit({ firmId: operation.firmId, decision: "ACTION", action: "APPROVED", clockId: operation.clockId, operationId: operation.operationId, atSim, refs: { brokerId }, detail: { cancelledTimers: cancelled.length } });
        await countHumanAction(ctx, operation, "APPROVE", "APPROVED");
        return { operationId: approved.operationId, dossierStatus: approved.dossierStatus, approvedBy: brokerId, approvedAtSim: approved.approvedAtSim ?? atSim };
      },
    },
    deps,
  );
}

export function reopenDossierHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "reopen_dossier",
      input: DossierReopenInput,
      callers: ["CONSOLE", "QA"],
      roles: APPROVER_ROLES,
      async run(ctx) {
        const brokerId = actingBroker(ctx.caller);
        const operation = await fencedOperation(ctx, ctx.input.operationId);
        if (operation.dossierStatus !== "APPROVED") throw new ToolError("CONFLICT", `the dossier is ${operation.dossierStatus}, not approved`, "NOT_APPROVED");
        const { atSim } = await ctx.world(operation.clockId);
        const reopened = await ctx.connector.operations.transitionDossier({
          operationId: operation.operationId,
          to: "REOPENED",
          atSim,
          atReal: ctx.now().toISOString(),
          by: ctx.actor,
          reason: ctx.input.reason,
          expectedVersion: operation.version,
        });
        await ctx.audit({ firmId: operation.firmId, decision: "ACTION", action: "REOPENED", clockId: operation.clockId, operationId: operation.operationId, atSim, reason: ctx.input.reason, refs: { brokerId } });
        await countHumanAction(ctx, operation, "REOPEN", "REOPENED");
        return { operationId: reopened.operationId, dossierStatus: reopened.dossierStatus, reopenedAtSim: atSim };
      },
    },
    deps,
  );
}
