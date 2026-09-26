// The AgentCore Gateway of the local flows: the same Cedar statements the stage attaches
// (infra/policy-rules.ts, rendered for a local Gateway ARN and Harness role) evaluated with the local
// evaluator of that module, in front of the target Lambdas. Cedar sees what it sees in the stage:
// principal (the Harness role), action `<target>___<tool>`, resource (the Gateway) and `context.input`.
// A denied call never reaches a target; an allowed one goes to the targets port unchanged.
import { GATEWAY_TOOLS, GatewayToolName, ToolTarget, gatewayActionName, toolTargetOf } from "@legajo/shared";
import { assumedRoleEntityId, cedarPolicies, evaluateCedar, type CedarDecision, type CedarPolicyDefinition } from "../../../infra/policy-rules";
import type { ToolInvocation, ToolTargetsPort } from "./ports";

/** A made-up account: nothing in the local flows names a real account or ARN of the stage. */
export const LOCAL_ACCOUNT = "000000000000";

export const LOCAL_GATEWAY = {
  gatewayArn: `arn:aws:bedrock-agentcore:us-east-1:${LOCAL_ACCOUNT}:gateway/legajo-local-flows`,
  harnessPrincipalId: assumedRoleEntityId(LOCAL_ACCOUNT, "legajo-local-flows-harness"),
} as const;

export interface GatewayCall {
  readonly target: ToolTarget;
  readonly tool: GatewayToolName;
  readonly action: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cedar: CedarDecision;
  /** What the target answered; `undefined` when Cedar denied the call. */
  readonly output: unknown;
}

export interface LocalGatewayOptions {
  readonly targets: ToolTargetsPort;
  /** The stage's statements by default; a test may pass them with the kill switch on. */
  readonly policies?: readonly CedarPolicyDefinition[];
  /** Principal of the call; the Harness role unless a test impersonates another one. */
  readonly principal?: string;
}

export interface LocalGateway {
  readonly policies: readonly CedarPolicyDefinition[];
  call(tool: GatewayToolName, input: Readonly<Record<string, unknown>>): Promise<GatewayCall>;
}

export function localPolicies(options: { readonly killSwitchActive?: boolean } = {}): CedarPolicyDefinition[] {
  return cedarPolicies(LOCAL_GATEWAY, options);
}

/** Every tool the Gateway exposes, in target order. */
export const ALL_GATEWAY_TOOLS: readonly GatewayToolName[] = ToolTarget.options.flatMap((target) => GATEWAY_TOOLS[target]);

export function createLocalGateway(options: LocalGatewayOptions): LocalGateway {
  const policies = options.policies ?? localPolicies();
  const principal = options.principal ?? LOCAL_GATEWAY.harnessPrincipalId;
  return {
    policies,
    async call(tool, input) {
      const parsed = GatewayToolName.parse(tool);
      const invocation: ToolInvocation = { target: toolTargetOf(parsed), tool: parsed, action: gatewayActionName(parsed), input };
      const cedar = evaluateCedar(policies, { principal, action: invocation.action, resource: LOCAL_GATEWAY.gatewayArn, input });
      if (cedar.decision === "DENY") return { ...invocation, cedar, output: undefined };
      return { ...invocation, cedar, output: await options.targets.invoke(invocation) };
    },
  };
}
