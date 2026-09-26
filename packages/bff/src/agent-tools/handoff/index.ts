// Lambda entry of `ToolHandoff` (docs/architecture.md §9.2): infra/agent-tools.ts points the Function at
// `packages/bff/src/agent-tools/handoff/index.handler`. The factory is what the local flows and the tests
// build the target with, over the in-memory connector.
import type { Implementations } from "../common/context";
import { lambdaEntry } from "../common/deps";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { handoffImplementations } from "./handler";
import { HANDOFF_TOOLS } from "./schema";

export function createHandoffTarget(deps: ToolDeps, implementations: Implementations<typeof HANDOFF_TOOLS> = handoffImplementations): GatewayTargetRuntime {
  return createToolHandler({ target: "handoff", tools: HANDOFF_TOOLS, implementations }, deps);
}

export const handler = lambdaEntry(createHandoffTarget);
