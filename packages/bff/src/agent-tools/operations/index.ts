// Lambda entry of `ToolOperations` (docs/architecture.md §9.2): infra/agent-tools.ts points the Function at
// `packages/bff/src/agent-tools/operations/index.handler`. The factory is what the local flows and the tests
// build the target with, over the in-memory connector.
import type { Implementations } from "../common/context";
import { lambdaEntry } from "../common/deps";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { operationsImplementations } from "./handler";
import { OPERATIONS_TOOLS } from "./schema";

export function createOperationsTarget(deps: ToolDeps, implementations: Implementations<typeof OPERATIONS_TOOLS> = operationsImplementations): GatewayTargetRuntime {
  return createToolHandler({ target: "operations", tools: OPERATIONS_TOOLS, implementations }, deps);
}

export const handler = lambdaEntry(createOperationsTarget);
