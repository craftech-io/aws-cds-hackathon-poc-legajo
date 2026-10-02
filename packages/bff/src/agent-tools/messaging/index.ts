// Lambda entry of `ToolMessaging` (docs/architecture.md §9.2): infra/agent-tools.ts points the Function at
// `packages/bff/src/agent-tools/messaging/index.handler`. The factory is what the local flows and the tests
// build the target with, over the in-memory connector and their own pipeline ports.
import { createLogger } from "../../lib/log";
import type { OutboundDeps } from "../../outbound/deps";
import { stageOutboundDeps } from "../../outbound/stage";
import type { Implementations } from "../common/context";
import { lambdaEntry } from "../common/deps";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { type MessagingPorts, messagingImplementations } from "./handler";
import { MESSAGING_TOOLS } from "./schema";

/** The pipeline's ports of the stage, built once on the first send of the container. */
export function productionMessagingPorts(deps: Pick<ToolDeps, "connector">): MessagingPorts {
  let outbound: OutboundDeps | undefined;
  return { outbound: () => (outbound ??= stageOutboundDeps(createLogger({ correlationId: "tool-messaging" }), { data: deps.connector })) };
}

export function createMessagingTarget(deps: ToolDeps, implementations: Implementations<typeof MESSAGING_TOOLS> = messagingImplementations(productionMessagingPorts(deps))): GatewayTargetRuntime {
  return createToolHandler({ target: "messaging", tools: MESSAGING_TOOLS, implementations }, deps);
}

export const handler = lambdaEntry(createMessagingTarget);
