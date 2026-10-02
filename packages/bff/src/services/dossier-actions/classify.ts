// `classify_unrecognized` (docs/tool-catalog.md; ADR-0003; FL-044): a PDF the reader did not recognize
// is never classified by us. A person decides:
//
//   CLASSIFY   the version becomes `CLASSIFIED` as the type the firm chose (`classifiedAs`,
//              `classifiedBy`) and that document is `VALID` by a human decision, without a reading;
//              the audit says so (`reading: NONE`);
//   DISCARD    the version becomes `DISCARDED` (`discardedBy`) and no document moves.
//
// The version must be one of the operation's and still `UNRECOGNIZED` (`CONFLICT` otherwise; another
// operation's id is `NOT_FOUND`). The `UNRECOGNIZED_DOCUMENT` escalation of that version is resolved,
// the human action counted and, when a classification completes the dossier, `request_approval` runs.
import { ClassifyDocumentInput, ToolError } from "@legajo/shared";
import { createDirectHandler } from "../operations-admin/handler-kit";
import { countHumanAction } from "../operations-admin/human-actions";
import type { ServiceDeps } from "../operations-admin/ports";
import { fencedOperation } from "../operations-admin/world-scope";
import { requestApprovalIfComplete } from "./completion";
import { resolveMatching } from "./escalations";

export function classifyUnrecognizedHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "classify_unrecognized",
      input: ClassifyDocumentInput,
      callers: ["CONSOLE", "QA"],
      roles: ["BROKER", "ANALYST", "GUEST"],
      async run(ctx) {
        const { input } = ctx;
        const operation = await fencedOperation(ctx, input.operationId);
        const version = await ctx.connector.documents.findVersion(input.docVersionId);
        if (version === undefined || version.operationId !== operation.operationId) throw new ToolError("NOT_FOUND", "the document version is not of this operation", "VERSION_NOT_FOUND");
        if (version.state !== "UNRECOGNIZED") throw new ToolError("CONFLICT", `the version is ${version.state}, not unrecognized`, "VERSION_NOT_UNRECOGNIZED");
        if (operation.dossierStatus === "APPROVED") throw new ToolError("CONFLICT", "an approved dossier is reopened before changing it", "DOSSIER_APPROVED");

        const { atSim } = await ctx.world(operation.clockId);
        const { documents } = ctx.connector;
        let documentStatus: string | undefined;
        if (input.outcome === "CLASSIFY") {
          await documents.updateVersion(operation.operationId, version.docType, version.versionNo, { state: "CLASSIFIED", classifiedAs: input.docType, classifiedBy: ctx.actor }, version.version);
          const target = await documents.getDocument(operation.operationId, input.docType);
          const valid = target.status === "VALID" ? target : await documents.updateDocument(operation.operationId, input.docType, { status: "VALID" }, target.version);
          documentStatus = valid.status;
        } else {
          await documents.updateVersion(operation.operationId, version.docType, version.versionNo, { state: "DISCARDED", discardedBy: ctx.actor }, version.version);
        }
        const escalations = await resolveMatching(ctx, operation.operationId, atSim, input.outcome === "CLASSIFY" ? "CLASSIFIED" : "DISCARDED", (escalation) => escalation.reason === "UNRECOGNIZED_DOCUMENT" && escalation.docVersionId === version.docVersionId);
        await ctx.audit({
          firmId: operation.firmId,
          decision: "ACTION",
          action: input.outcome === "CLASSIFY" ? "DOCUMENT_CLASSIFIED" : "DOCUMENT_DISCARDED",
          clockId: operation.clockId,
          operationId: operation.operationId,
          atSim,
          refs: { docVersionId: version.docVersionId, ...(ctx.caller.brokerId === undefined ? {} : { brokerId: ctx.caller.brokerId }) },
          detail: input.outcome === "CLASSIFY" ? { classifiedAs: input.docType, validatedBy: "HUMAN_CLASSIFICATION", reading: "NONE", resolvedEscalations: escalations.length } : { resolvedEscalations: escalations.length },
        });
        await countHumanAction(ctx, operation, "CLASSIFY");
        const approvalRequested = input.outcome === "CLASSIFY" ? await requestApprovalIfComplete(ctx, deps, operation, atSim) : false;
        return {
          operationId: operation.operationId,
          docVersionId: version.docVersionId,
          outcome: input.outcome,
          ...(input.outcome === "CLASSIFY" ? { classifiedAs: input.docType } : {}),
          ...(documentStatus === undefined ? {} : { documentStatus }),
          approvalRequested,
        };
      },
    },
    deps,
  );
}
