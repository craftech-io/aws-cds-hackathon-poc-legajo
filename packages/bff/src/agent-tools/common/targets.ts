// The five Gateway targets together, over one set of dependencies: what the local flows put behind their
// Gateway (tests/flows/support/gateway.ts evaluates Cedar, then hands the allowed call to a
// `ToolTargetsPort`) and what the worker and the console call in process.
import { ToolTarget } from "@legajo/shared";
import { createDocumentsTarget } from "../documents/index";
import { createFollowupsTarget } from "../followups/index";
import { createHandoffTarget } from "../handoff/index";
import { createMessagingTarget } from "../messaging/index";
import { createOperationsTarget } from "../operations/index";
import type { ToolResponse } from "./context";
import type { GatewayTargetRuntime, ToolDeps } from "./handler";
import { gatewayContext } from "./principal";

export type GatewayTargets = { readonly [T in ToolTarget]: GatewayTargetRuntime };

export function createGatewayTargets(deps: ToolDeps): GatewayTargets {
  return {
    operations: createOperationsTarget(deps),
    documents: createDocumentsTarget(deps),
    messaging: createMessagingTarget(deps),
    followups: createFollowupsTarget(deps),
    handoff: createHandoffTarget(deps),
  };
}

/** A call Cedar allowed, as the Gateway hands it to its target (`action` = `<target>___<tool>`). */
export interface AllowedGatewayCall {
  readonly target: ToolTarget;
  readonly action: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * The targets as the local flows' Gateway calls them: the arguments as the event and the Gateway's marks
 * in the client context, exactly what a target Lambda receives in the stage.
 */
export function gatewayTargetsPort(targets: GatewayTargets): { invoke(call: AllowedGatewayCall): Promise<ToolResponse> } {
  return {
    invoke: (call) => targets[ToolTarget.parse(call.target)].handle({ ...call.input }, gatewayContext(call.action)),
  };
}
