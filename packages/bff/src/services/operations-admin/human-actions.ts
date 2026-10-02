// Human actions on an operation (docs/design-brief.md §8, CONTEXT.md): taking the conversation, writing
// to the importer, waiving, classifying, approving and reopening. Each one counts on the dossier's KPI
// row: one human action, one intervention and the minutes the firm declares for it
// (`Firms/SETTINGS.humanActionMinutes`, a labelled assumption). The console heartbeat adds observed
// console time apart (`record_activity`). A KPI write that fails is logged and never undoes the action:
// the metric is secondary to the dossier.
import type { DossierStatus } from "@legajo/shared";
import type { HumanAction } from "../../domain/firms";
import type { DirectContext } from "./handler-kit";
import { kpiRefOf } from "./world-scope";

interface CountedOperation {
  readonly operationId: string;
  readonly firmId: string;
  readonly clockId: string;
}

async function minutesOf(ctx: DirectContext<unknown>, firmId: string, action: HumanAction): Promise<number> {
  const settings = await ctx.connector.firms.getSettings(firmId);
  return settings.humanActionMinutes.items.find((item) => item.action === action)?.minutes ?? 0;
}

export async function countHumanAction(ctx: DirectContext<unknown>, operation: CountedOperation, action: HumanAction, dossierStatus?: DossierStatus): Promise<void> {
  const ref = kpiRefOf(operation);
  try {
    const minutes = await minutesOf(ctx, operation.firmId, action);
    await ctx.connector.metrics.incrementKpi(ref, { humanActions: 1, interventions: 1, humanMinutes: minutes }, { agentMode: "REAL" });
    if (dossierStatus !== undefined) await ctx.connector.metrics.updateKpi(ref, { dossierStatus });
  } catch (error) {
    ctx.log.error("human action not counted", { action, operationId: operation.operationId, error: error instanceof Error ? error.name : "unknown" });
  }
}

/** `record_activity`: observed console seconds on the dossier (a heartbeat every 30 s). */
export async function countConsoleSeconds(ctx: DirectContext<unknown>, operation: CountedOperation, seconds: number): Promise<void> {
  await ctx.connector.metrics.incrementKpi(kpiRefOf(operation), { consoleSeconds: seconds }, { agentMode: "REAL" });
}
