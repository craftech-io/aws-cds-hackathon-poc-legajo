// IAM of the agent (docs/architecture.md §14, rows "Harness (ejecución)" and "Gateway", docs/build-plan.md
// WP-23): three roles assumed by `bedrock-agentcore.amazonaws.com`, each with one inline policy whose
// statements are plain data in infra/agentcore-spec.ts (checked by infra/agentcore-spec.test.ts).
//
//   <app>-<stage>-gateway  lambda:InvokeFunction on the five target Lambdas and nothing else, plus the three
//                          policy engine actions the Gateway needs to evaluate Cedar. The target Lambdas
//                          name this role in their resource policy (infra/agent-tools.ts).
//   <app>-<stage>-harness  the Harness execution role: the model (inference profile and its two foundation
//                          model ARNs), ApplyGuardrail on G1, InvokeGateway, the Memory event and retrieval
//                          actions, its own runtime logs, traces, metrics and the managed image pull.
//   <app>-<stage>-memory   assumed by Memory to run the agent model of the three custom strategies (a
//                          strategy with a prompt override requires a memory execution role).
//
// Names are fixed because Cedar names the Harness by `assumed-role/<name>` (infra/policy.ts) and
// `iam get-role-policy` needs them. The path `/<app>/` and the permissions boundary come from the
// $transform of infra/ci.ts; nothing here sets them. Imported by infra/agent-tools.ts (the Gateway role in
// the targets' resource policy) and infra/agentcore.ts (the policies, scoped to the resources it creates).
//
// Trust: `aws:SourceAccount` always; `aws:SourceArn` is the gateway id pattern for the Gateway role (known
// before the Gateway exists, so the role does not depend on it) and the AgentCore resources of this
// account for the Harness and Memory roles, whose assume-role source (harness, underlying runtime or
// memory) is not documented precisely enough to narrow further.
//
// Verify:
//   aws --profile craftech-demos iam get-role-policy --role-name aws-cds-hackathon-poc-legajo-poc-gateway --policy-name <name>
//   aws --profile craftech-demos iam list-role-policies --role-name aws-cds-hackathon-poc-legajo-poc-harness
//   aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-legajo-poc-memory
//     → Path /aws-cds-hackathon-poc-legajo/, PermissionsBoundary …-ci-boundary, trust bedrock-agentcore.amazonaws.com

import {
  agentCoreArnPrefix,
  agentCoreTrustPolicy,
  agentRoleName,
  gatewayArnPattern,
  gatewayRoleStatements,
  harnessRoleStatements,
  memoryRoleStatements,
  policyDocument,
  type AgentPlace,
} from "./agentcore-spec";

/** Account and region of the provider, the scope of every ARN of the agent's policies. */
export const agentPlace: $util.Output<AgentPlace> = $util
  .all([aws.getCallerIdentityOutput({}).accountId, aws.getRegionOutput({}).region])
  .apply(([account, region]) => ({ account, region }));

const anyAgentCoreResource = agentPlace.apply((place) => agentCoreTrustPolicy(place, `${agentCoreArnPrefix(place)}:*`));

// ---- Memory execution role --------------------------------------------------------------------------

export const memoryRole = new aws.iam.Role("AgentMemoryRole", {
  name: agentRoleName($app.name, $app.stage, "memory"),
  description: "Assumed by AgentCore Memory to run the agent model of the three custom strategies.",
  assumeRolePolicy: anyAgentCoreResource,
});

export const memoryRolePolicy = new aws.iam.RolePolicy("AgentMemoryRolePolicy", {
  role: memoryRole.id,
  policy: agentPlace.apply((place) => policyDocument(memoryRoleStatements(place))),
});

// ---- Gateway service role ---------------------------------------------------------------------------

export const gatewayRole = new aws.iam.Role("AgentGatewayRole", {
  name: agentRoleName($app.name, $app.stage, "gateway"),
  description: "Assumed by the AgentCore Gateway: invokes the five tool Lambdas and evaluates Cedar.",
  assumeRolePolicy: agentPlace.apply((place) => agentCoreTrustPolicy(place, gatewayArnPattern(place, $app.name, $app.stage))),
});

export interface GatewayRolePolicyArgs {
  /** ARNs of the five target Lambdas, the only functions the Gateway may invoke. */
  readonly functionArns: ReadonlyArray<$util.Input<string>>;
  readonly policyEngineArn: $util.Input<string>;
}

export function createGatewayRolePolicy(args: GatewayRolePolicyArgs): aws.iam.RolePolicy {
  return new aws.iam.RolePolicy("AgentGatewayRolePolicy", {
    role: gatewayRole.id,
    policy: $util
      .all([agentPlace, $util.all([...args.functionArns]), args.policyEngineArn])
      .apply(([place, functionArns, policyEngineArn]) => policyDocument(gatewayRoleStatements(place, $app.name, $app.stage, functionArns, policyEngineArn))),
  });
}

// ---- Harness execution role ---------------------------------------------------------------------------
// The role exists first (Cedar names it); its policy scopes to the Gateway, Memory and G1.

export const harnessRole = new aws.iam.Role("AgentHarnessRole", {
  name: agentRoleName($app.name, $app.stage, "harness"),
  description: "Execution role of the AgentCore Harness: model, G1, Gateway, Memory, runtime logs and traces.",
  assumeRolePolicy: anyAgentCoreResource,
});

export interface HarnessRolePolicyArgs {
  readonly gatewayArn: $util.Input<string>;
  readonly memoryArn: $util.Input<string>;
  /** G1 (infra/guardrail.ts), the guardrail of the Harness model calls. */
  readonly guardrailArn: $util.Input<string>;
}

export function createHarnessRolePolicy(args: HarnessRolePolicyArgs): aws.iam.RolePolicy {
  return new aws.iam.RolePolicy("AgentHarnessRolePolicy", {
    role: harnessRole.id,
    policy: $util
      .all([agentPlace, args.gatewayArn, args.memoryArn, args.guardrailArn])
      .apply(([place, gatewayArn, memoryArn, guardrailArn]) => policyDocument(harnessRoleStatements(place, $app.name, $app.stage, { gatewayArn, memoryArn, guardrailArn }))),
  });
}
