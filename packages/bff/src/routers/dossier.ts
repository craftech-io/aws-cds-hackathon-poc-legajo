// `dossier` router (docs/tool-catalog.md "Procedimientos de la consola"; FL-043, FL-044, FL-073, FL-075,
// FL-076): the firm's decisions on a dossier, over the direct handlers of services/dossier-actions with
// the caller the principal stands for. Inputs are the shared ones (packages/shared/src/console-inputs.ts),
// the same the console and the scenarios send.
//
//   approve            BROKER or GUEST with a sign-in ≤ 15 min (`recentLoginProcedure`, ADR-0010); an
//                      ANALYST gets 403 and `AuditLog DENY ROLE_NOT_ALLOWED` (FL-075). On success the
//                      Bff emits `CostPerDossier` with the dossier's cost when every rate is verified
//   reopen             the same gate; the agent takes the dossier up again
//   waiveObservation   BROKER, ANALYST or GUEST (the handler checks the role)
//   classifyDocument   classify an unrecognized version as a type, or discard it
//   requestUploadLink  `create_upload_link` for the operation's importer (72 h, only what the importer
//                      may bring); one `PDF_UPLOADS` of a guest world
import { z } from "zod";
import { ClassifyDocumentInput, DocType, DossierApproveInput, DossierReopenInput, OperationId, WaiveObservationInput } from "@legajo/shared";
import { countMetric } from "../channels/adapter";
import { costOf, pricingRows } from "../metrics/kpis";
import { kpiRefOf } from "../services/operations-admin/world-scope";
import { callerOf, consoleServicesOf, consumeConsoleQuota, runDirect } from "./console-services";
import { requireToolOk } from "./errors";
import { type FirmContext, firmProcedure, recentLoginProcedure, router } from "./trpc";

/** Metric of an approved dossier's cost (docs/architecture.md §12; infra/observability-spec.ts). */
export const COST_PER_DOSSIER_METRIC = "CostPerDossier";

export const RequestUploadLinkInput = z.object({ operationId: OperationId, docTypes: z.array(DocType).min(1).max(DocType.options.length) }).strict();

const UploadLinkAnswer = z.object({ url: z.string().min(1), expiresAtText: z.string().min(1) }).loose();

/**
 * `CostPerDossier` of the dossier just approved: one line per approval, only with verified rates (a
 * dossier priced with a provisional rate is not a measurement). Never fails the approval.
 */
async function emitDossierCost(ctx: FirmContext, operationId: string): Promise<void> {
  try {
    const data = ctx.deps.connector;
    const operation = await data.operations.getOperation(operationId);
    const [row, rateCard] = await Promise.all([data.metrics.getKpi(kpiRefOf(operation)), data.reference.listRateCard()]);
    if (row === undefined) return;
    const cost = costOf(row, pricingRows(rateCard), ctx.deps.whatsappMode() === "simulated");
    if (cost.status !== "VERIFIED") {
      ctx.log.info("dossier.cost_unverified", { operationId, missingRates: [...cost.missingRates] });
      return;
    }
    countMetric(ctx.log, COST_PER_DOSSIER_METRIC, { costUsd: cost.usd, whatsappPricedAsLive: cost.whatsappPricedAsLive });
  } catch (error) {
    ctx.log.warn("dossier.cost_not_emitted", { operationId, error: error instanceof Error ? error.name : "unknown" });
  }
}

export const dossierRouter = router({
  approve: recentLoginProcedure.input(DossierApproveInput).mutation(async ({ ctx, input }) => {
    const approved = await runDirect(ctx, "approve_dossier", input);
    await emitDossierCost(ctx, input.operationId);
    return approved;
  }),

  reopen: recentLoginProcedure.input(DossierReopenInput).mutation(({ ctx, input }) => runDirect(ctx, "reopen_dossier", input)),

  waiveObservation: firmProcedure.input(WaiveObservationInput).mutation(({ ctx, input }) => runDirect(ctx, "waive_observation", input)),

  classifyDocument: firmProcedure.input(ClassifyDocumentInput).mutation(({ ctx, input }) => runDirect(ctx, "classify_unrecognized", input)),

  requestUploadLink: firmProcedure.input(RequestUploadLinkInput).mutation(async ({ ctx, input }) => {
    const operation = await ctx.deps.connector.operations.getOperation(input.operationId);
    await ctx.firmScope.assertFirm(operation.firmId);
    await consumeConsoleQuota(ctx, operation.clockId, "PDF_UPLOADS");
    const answer = await consoleServicesOf(ctx.deps).uploadLinks.create({ caller: callerOf(ctx.principal), operationId: operation.operationId, docTypes: input.docTypes });
    const link = requireToolOk(answer, UploadLinkAnswer);
    return { operationId: operation.operationId, docTypes: input.docTypes, url: link.url, expiresAtText: link.expiresAtText };
  }),
});
