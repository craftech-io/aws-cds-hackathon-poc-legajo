// Lambda entry of `ToolHandoff` (docs/architecture.md §9.2): infra/agent-tools.ts points the Function at
// `packages/bff/src/agent-tools/handoff/index.handler`. The factory is what the worker (in process,
// `caller WORKER`), the local flows and the tests build the target with, over the in-memory connector
// and their own pipeline; the Lambda gets the stage's pipeline (outbound/stage.ts).
import { createLogger } from "../../lib/log";
import type { OutboundDeps } from "../../outbound/deps";
import { sendOutbound } from "../../outbound/pipeline";
import { stageOutboundDeps } from "../../outbound/stage";
import type { Implementations } from "../common/context";
import { lambdaEntry } from "../common/deps";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { type HandoffPorts, handoffImplementations } from "./handler";
import { HANDOFF_TOOLS } from "./schema";

/** The pipeline of the stage, built once on the first send of the container. */
export function productionHandoffPorts(deps: Pick<ToolDeps, "connector">): HandoffPorts {
  let outbound: OutboundDeps | undefined;
  return {
    send: (request, call) => sendOutbound((outbound ??= stageOutboundDeps(createLogger({ correlationId: "tool-handoff" }), { data: deps.connector })), request, call),
    agentMode: "REAL",
  };
}

export function createHandoffTarget(deps: ToolDeps, implementations: Implementations<typeof HANDOFF_TOOLS> = handoffImplementations(productionHandoffPorts(deps))): GatewayTargetRuntime {
  return createToolHandler({ target: "handoff", tools: HANDOFF_TOOLS, implementations }, deps);
}

export const handler = lambdaEntry(createHandoffTarget);
