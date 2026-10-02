// `record_activity` (docs/tool-catalog.md; `activity.heartbeat`): the console's 30-second heartbeat while
// a person has a dossier open. It adds observed console seconds to the dossier's KPI row in its world
// (`LegajoMetrics`, a secondary metric labelled as observed) and writes nothing else: no audit row per
// beat. A beat never counts more than 60 seconds, so a late or repeated one cannot inflate the time.
import { z } from "zod";
import { OperationId } from "@legajo/shared";
import { createDirectHandler } from "./handler-kit";
import { countConsoleSeconds } from "./human-actions";
import type { ServiceDeps } from "./ports";

export const HEARTBEAT_SECONDS = 30;
export const MAX_HEARTBEAT_SECONDS = 60;

export const RecordActivityInput = z.object({ operationId: OperationId, seconds: z.number().int().min(1).max(MAX_HEARTBEAT_SECONDS).default(HEARTBEAT_SECONDS) }).strict();

export function recordActivityHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "record_activity",
      input: RecordActivityInput,
      callers: ["CONSOLE"],
      async run(ctx) {
        const operation = await ctx.connector.operations.getOperation(ctx.input.operationId);
        await ctx.fence(operation.firmId, { kind: "operation", id: operation.operationId });
        await countConsoleSeconds(ctx, operation, ctx.input.seconds);
        return { operationId: operation.operationId, seconds: ctx.input.seconds };
      },
    },
    deps,
  );
}
