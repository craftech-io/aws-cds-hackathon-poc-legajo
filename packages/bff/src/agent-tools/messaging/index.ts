// Lambda entry of `ToolMessaging` (docs/architecture.md §9.2): infra/agent-tools.ts points the Function at
// `packages/bff/src/agent-tools/messaging/index.handler`. The factory is what the local flows and the tests
// build the target with, over the in-memory connector.
import type { Implementations } from "../common/context";
import { lambdaEntry } from "../common/deps";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { messagingImplementations } from "./handler";
import { MESSAGING_TOOLS } from "./schema";

export function createMessagingTarget(deps: ToolDeps, implementations: Implementations<typeof MESSAGING_TOOLS> = messagingImplementations): GatewayTargetRuntime {
  return createToolHandler({ target: "messaging", tools: MESSAGING_TOOLS, implementations }, deps);
}

export const handler = lambdaEntry(createMessagingTarget);
