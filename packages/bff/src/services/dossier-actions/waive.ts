// `waive_observation` (docs/tool-catalog.md, FL-043): the firm waives an observation the reader made,
// with its reason; only people waive (roles `BROKER`, `ANALYST` and `GUEST`, never the agent).
//
//   - the observation must be one of the operation's and still open (`OPEN`, `CORRECTION_REQUESTED`,
//     `ESCALATED`); one already waived changes nothing; a resolved one is `CONFLICT`; an approved
//     dossier is reopened first (`CONFLICT`);
//   - `WAIVED_BY_BROKER` with `waiveReason`, dated at the world's simulated now, and its escalation
//     resolved;
//   - the document is settled again: `VALID` (validated by the waiver) when nothing blocking is left;
//   - `ACTION WAIVED` with `brokerId`, the human action counted, and `request_approval` when the
//     dossier is complete.
import { ToolError, WaiveObservationInput } from "@legajo/shared";
import { OPEN_OBSERVATION_STATUSES } from "../../domain/documents";
import { settleDocument } from "../../intake/document-status";
import { createDirectHandler } from "../operations-admin/handler-kit";
import { countHumanAction } from "../operations-admin/human-actions";
import type { ServiceDeps } from "../operations-admin/ports";
import { fencedOperation } from "../operations-admin/world-scope";
import { requestApprovalIfComplete } from "./completion";
import { resolveMatching } from "./escalations";

export function waiveObservationHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "waive_observation",
      input: WaiveObservationInput,
      callers: ["CONSOLE", "QA"],
      roles: ["BROKER", "ANALYST", "GUEST"],
      async run(ctx) {
        const { input } = ctx;
        const operation = await fencedOperation(ctx, input.operationId);
        const observation = await ctx.connector.documents.findObservation(operation.operationId, input.observationId);
        if (observation === undefined) throw new ToolError("NOT_FOUND", "the observation is not of this operation", "OBSERVATION_NOT_FOUND");
        if (observation.status === "WAIVED_BY_BROKER") return { operationId: operation.operationId, observationId: observation.observationId, status: observation.status, changed: false };
        if (!OPEN_OBSERVATION_STATUSES.includes(observation.status)) throw new ToolError("CONFLICT", `the observation is ${observation.status}`, "OBSERVATION_CLOSED");
        if (operation.dossierStatus === "APPROVED") throw new ToolError("CONFLICT", "an approved dossier is reopened before changing it", "DOSSIER_APPROVED");

        const { atSim } = await ctx.world(operation.clockId);
        const waived = await ctx.connector.documents.transitionObservation({
          operationId: operation.operationId,
          observationId: observation.observationId,
          to: "WAIVED_BY_BROKER",
          atSim,
          atReal: ctx.now().toISOString(),
          by: ctx.actor,
          reason: input.reason,
          patch: { waiveReason: input.reason },
          expectedVersion: observation.version,
        });
        const escalations = await resolveMatching(ctx, operation.operationId, atSim, "WAIVED", (escalation) => escalation.escalationId === observation.escalationId || escalation.observationId === observation.observationId);
        const document = await settleDocument(ctx.connector, operation.operationId, observation.docType);
        await ctx.audit({
          firmId: operation.firmId,
          decision: "ACTION",
          action: "WAIVED",
          clockId: operation.clockId,
          operationId: operation.operationId,
          atSim,
          reason: input.reason,
          refs: { observationId: observation.observationId, ...(ctx.caller.brokerId === undefined ? {} : { brokerId: ctx.caller.brokerId }) },
          detail: { docType: observation.docType, code: observation.code, documentStatus: document.status, resolvedEscalations: escalations.length },
        });
        await countHumanAction(ctx, operation, "WAIVE");
        const approvalRequested = await requestApprovalIfComplete(ctx, deps, operation, atSim);
        return { operationId: operation.operationId, observationId: waived.observationId, status: waived.status, changed: true, documentStatus: document.status, approvalRequested };
      },
    },
    deps,
  );
}
