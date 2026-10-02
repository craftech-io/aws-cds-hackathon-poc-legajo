// Lambda entry of `ToolFollowups` (docs/architecture.md §9.2): infra/agent-tools.ts points the Function at
// `packages/bff/src/agent-tools/followups/index.handler`. The factory is what the local flows and the tests
// build the target with, over the in-memory connector and their own timer ports; the Lambda gets the
// stage's (Scheduler, `OperationEvents` and `SimMail` links, timers/stage.ts).
import type { Implementations } from "../common/context";
import { lambdaEntry } from "../common/deps";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { stageTimerPorts } from "../../timers/stage";
import { followupsImplementations } from "./handler";
import { FOLLOWUPS_TOOLS } from "./schema";

export function createFollowupsTarget(deps: ToolDeps, implementations: Implementations<typeof FOLLOWUPS_TOOLS> = followupsImplementations(stageTimerPorts(deps.connector.world))): GatewayTargetRuntime {
  return createToolHandler({ target: "followups", tools: FOLLOWUPS_TOOLS, implementations }, deps);
}

export const handler = lambdaEntry(createFollowupsTarget);
