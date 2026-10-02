// The five Gateway targets together, over one set of dependencies: what the local flows put behind their
// Gateway (tests/flows/support/gateway.ts evaluates Cedar, then hands the allowed call to a
// `ToolTargetsPort`) and what the worker and the console call in process.
import { ToolTarget } from "@legajo/shared";
import type { TimerPorts } from "../../timers/stage";
import { documentsImplementations } from "../documents/handler";
import { createDocumentsTarget } from "../documents/index";
import type { DocumentToolPorts } from "../documents/ports";
import { followupsImplementations } from "../followups/handler";
import { createFollowupsTarget } from "../followups/index";
import { type HandoffPorts, handoffImplementations } from "../handoff/handler";
import { createHandoffTarget } from "../handoff/index";
import { type MessagingPorts, messagingImplementations } from "../messaging/handler";
import { createMessagingTarget } from "../messaging/index";
import { createOperationsTarget } from "../operations/index";
import type { ToolResponse } from "./context";
import type { GatewayTargetRuntime, ToolDeps } from "./handler";
import { gatewayContext } from "./principal";

export type GatewayTargets = { readonly [T in ToolTarget]: GatewayTargetRuntime };

/** The ports of the targets that reach outside the connector; each one left out is the stage's. */
export interface GatewayTargetPorts {
  readonly messaging?: MessagingPorts;
  readonly handoff?: HandoffPorts;
  readonly followups?: TimerPorts;
  readonly documents?: DocumentToolPorts;
}

export function createGatewayTargets(deps: ToolDeps, ports: GatewayTargetPorts = {}): GatewayTargets {
  return {
    operations: createOperationsTarget(deps),
    documents: ports.documents === undefined ? createDocumentsTarget(deps) : createDocumentsTarget(deps, documentsImplementations(ports.documents)),
    messaging: ports.messaging === undefined ? createMessagingTarget(deps) : createMessagingTarget(deps, messagingImplementations(ports.messaging)),
    followups: ports.followups === undefined ? createFollowupsTarget(deps) : createFollowupsTarget(deps, followupsImplementations(ports.followups)),
    handoff: ports.handoff === undefined ? createHandoffTarget(deps) : createHandoffTarget(deps, handoffImplementations(ports.handoff)),
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
