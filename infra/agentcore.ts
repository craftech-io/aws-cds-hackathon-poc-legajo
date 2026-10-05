// Bedrock AgentCore: the agent as resources (docs/architecture.md §4, §9 and §12, docs/design-brief.md
// §5.3-§5.6, docs/build-plan.md WP-23). Names, limits, strategies and verified service facts:
// infra/agentcore-spec.ts; roles: infra/agentcore-iam.ts; tool Lambdas: infra/agent-tools.ts; schemas:
// infra/agent-tool-schemas.ts; Cedar: infra/policy.ts; G1: infra/guardrail.ts.
//
//   Memory      `aws_cds_hackathon_poc_legajo_poc`, events 30 days, three custom strategies with the same
//               exclusion rules: `importerPreferences` (userPreference override), `importerFacts` (semantic
//               override) and `operationSummary` (summary override), all per importer actor
//               (`imp-<importerId>-e<worldEpoch>`, passed by the worker on every invocation).
//   Gateway     `aws-cds-hackathon-poc-legajo-poc`, MCP, `AWS_IAM`, called only by the Harness role; the
//               policy engine of infra/policy.ts in ENFORCE.
//   Targets     operations, documents, messaging, followups, handoff: Lambda + inline schema, created ONE
//               AT A TIME (Cloud Control rejects concurrent target writes on a gateway) through a dependsOn
//               chain, with ignoreChanges (GATEWAY_SCHEMA_ROLLOUT says how a schema change ships).
//   Policies    the Cedar statements CED-* of WP-09, attached after the LAST target: the engine validates
//               each statement against the Gateway's tool schemas.
//   Harness     global.anthropic.claude-haiku-4-5-20251001-v1:0 (through the tagged application profile <app>-<stage>-agent-model,
//               also the Memory model) over converse_stream with G1 in the model parameters;
//               maxIterations 12, maxTokens 2048, timeout 120 s, sliding window 40; tools = the Gateway
//               only (`@legajo-tools/*`), so no shell, file or code tools; the default system prompt of
//               packages/bff/src/agent/system-prompt.ts; public network, idle microVMs stopped after 5
//               minutes. Created after the policies, so no turn ever runs without the fences.
//   Log group   `/aws/bedrock-agentcore/runtimes/<runtimeId>-live`, 30 days, created after the Harness and
//               before the endpoint (never the DEFAULT one, which AgentCore creates). Content capture in
//               traces cannot be turned off: TRACE_CONTENT_CAPTURE of infra/agentcore-spec.ts.
//   Endpoint    `live`, pinned to the Harness version of this deploy.
//
// What code links:
//   Harness   `Resource.Harness.{harnessArn, endpointName, …}` and InvokeHarness: OperationWorker only
//             (infra/operations.ts, late link), the only holder of the action (infra/iam-capabilities.ts).
//   Agent     `Resource.Agent.memoryId` and the namespaces, with MEMORY_ADMIN on this Memory: the roles
//             that hold WORLDS (WorldJanitor, Bff, QaDriver) for the purge and `memory.inspect`.
//
// Cost: per model token, Gateway call, policy evaluation, Memory event and record; nothing bills while idle.
//
// Verify (AWS CLI ≥ 2.27, or the SDK v3 scripts, docs/architecture.md §16):
//   aws --profile craftech-demos bedrock-agentcore-control list-harnesses                                  → READY
//   aws --profile craftech-demos bedrock-agentcore-control list-gateway-targets --gateway-identifier <id>  → 5 READY
//   aws --profile craftech-demos bedrock-agentcore-control get-memory --memory-id <id>                     → ACTIVE, 3 strategies
//   aws --profile craftech-demos logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/harness_aws_cds_hackathon_poc_legajo_poc
//     → <runtimeId>-live with retentionInDays 30 (-DEFAULT: AgentCore's, empty)

import { DEFAULT_SYSTEM_PROMPT } from "../packages/bff/src/agent/system-prompt";
import { ToolTarget } from "../packages/shared/src/tools";
import { gatewayInlinePayloads, gatewayToolSchemas } from "./agent-tool-schemas";
import { toolFunctions, toolGatewayInvokePermissions } from "./agent-tools";
import { agentModelProfile, createGatewayRolePolicy, createHarnessRolePolicy, gatewayRole, harnessRole, memoryRole, memoryRolePolicy } from "./agentcore-iam";
import {
  AGENT_LINK,
  AGENT_LOG_RETENTION_DAYS,
  GATEWAY_TOOL_NAME,
  HARNESS_ALLOWED_TOOLS,
  HARNESS_ENDPOINT_NAME,
  HARNESS_INVOKE_ACTIONS,
  HARNESS_LIFECYCLE,
  HARNESS_LIMITS,
  HARNESS_LINK,
  MEMORY_EVENT_EXPIRY_DAYS,
  MEMORY_STRATEGIES,
  gatewayName,
  gatewayTargetDescription,
  gatewayTargetIgnoreChanges,
  harnessBedrockModelConfig,
  harnessName,
  memoryName,
  memoryRetrievalConfig,
  memoryStrategyArgs,
  runtimeLogGroupEndpoints,
  runtimeLogGroupName,
  textDigest,
} from "./agentcore-spec";
import { g1, harnessGuardrailConfig } from "./guardrail";
import { CAPABILITIES } from "./iam-capabilities";
import { GATEWAY_POLICY_ENGINE_MODE, attachGatewayPolicies, policyEngineArn } from "./policy";
import { tagList, tagMap } from "./tags";

const pascal = (value: string): string => `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()}`;

// ---- Memory ------------------------------------------------------------------------------------------

export const memory = new awsnative.bedrockagentcore.Memory(
  "AgentMemory",
  {
    name: memoryName($app.name, $app.stage),
    description: `Importer preferences, facts and operation summaries of the ${$app.name} agent, stage ${$app.stage}.`,
    eventExpiryDuration: MEMORY_EVENT_EXPIRY_DAYS,
    memoryExecutionRoleArn: memoryRole.arn,
    memoryStrategies: agentModelProfile.arn.apply(memoryStrategyArgs),
    tags: tagMap(),
  },
  { dependsOn: [memoryRolePolicy] },
);

// ---- Gateway and its targets -------------------------------------------------------------------------

const gatewayRolePolicy = createGatewayRolePolicy({
  functionArns: ToolTarget.options.map((target) => toolFunctions[target].arn),
  policyEngineArn,
});

export const gateway = new awsnative.bedrockagentcore.Gateway(
  "AgentGateway",
  {
    name: gatewayName($app.name, $app.stage),
    description: `MCP tools of the ${$app.name} agent (${$app.stage}); called only by the Harness execution role.`,
    authorizerType: "AWS_IAM",
    protocolType: "MCP",
    roleArn: gatewayRole.arn,
    policyEngineConfiguration: { arn: policyEngineArn, mode: GATEWAY_POLICY_ENGINE_MODE },
    tags: tagMap(),
  },
  // The Gateway evaluates Cedar and invokes the targets with its role: without the policy the first call fails.
  { dependsOn: [gatewayRolePolicy] },
);

const targets = {} as Record<ToolTarget, awsnative.bedrockagentcore.GatewayTarget>;
// The first target waits for both sides of invoking the Lambdas: the role's policy and each target's resource policy.
let previous: $util.Resource[] = [gatewayRolePolicy, ...Object.values(toolGatewayInvokePermissions)];

for (const target of ToolTarget.options) {
  const { inlinePayload, digest } = gatewayToolSchemas[target];
  targets[target] = new awsnative.bedrockagentcore.GatewayTarget(
    `AgentGatewayTarget${pascal(target)}`,
    {
      gatewayIdentifier: gateway.gatewayIdentifier,
      // Cedar action ids are `<name>___<tool>` (infra/policy-rules.ts): the name is the target id.
      name: target,
      description: gatewayTargetDescription(target, inlinePayload.length, digest),
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      targetConfiguration: { mcp: { lambda: { lambdaArn: toolFunctions[target].arn, toolSchema: { inlinePayload } } } },
    },
    { dependsOn: previous, ignoreChanges: gatewayTargetIgnoreChanges(target) },
  );
  previous = [targets[target]];
}

export const gatewayTargets: Readonly<Record<ToolTarget, awsnative.bedrockagentcore.GatewayTarget>> = targets;

/** Cedar of WP-09, after the last target: permits first, then the forbids (infra/policy.ts). */
export const gatewayPolicies = attachGatewayPolicies({
  gatewayArn: gateway.gatewayArn,
  harnessRoleName: harnessRole.name,
  targetNames: ToolTarget.options,
  toolSchemas: gatewayInlinePayloads,
  dependsOn: previous,
});

// ---- Harness, its runtime log group and the endpoint --------------------------------------------------

const harnessRolePolicy = createHarnessRolePolicy({ modelProfileArn: agentModelProfile.arn, gatewayArn: gateway.gatewayArn, memoryArn: memory.memoryArn, guardrailArn: g1.guardrailArn });

export const harness = new awsnative.bedrockagentcore.Harness(
  "AgentHarness",
  {
    harnessName: harnessName($app.name, $app.stage),
    executionRoleArn: harnessRole.arn,
    // G1 on every model call (infra/guardrail.ts); the turn's own prompt comes from the worker.
    model: { bedrockModelConfig: harnessBedrockModelConfig(agentModelProfile.arn, harnessGuardrailConfig) },
    systemPrompt: [{ text: DEFAULT_SYSTEM_PROMPT }],
    environment: {
      agentCoreRuntimeEnvironment: {
        networkConfiguration: { networkMode: "PUBLIC" },
        lifecycleConfiguration: {
          idleRuntimeSessionTimeout: HARNESS_LIFECYCLE.idleRuntimeSessionTimeoutSeconds,
          maxLifetime: HARNESS_LIFECYCLE.maxLifetimeSeconds,
        },
      },
    },
    tools: [
      {
        type: "agentcore_gateway",
        name: GATEWAY_TOOL_NAME,
        config: { agentCoreGateway: { gatewayArn: gateway.gatewayArn, outboundAuth: { awsIam: {} } } },
      },
    ],
    allowedTools: [...HARNESS_ALLOWED_TOOLS],
    maxIterations: HARNESS_LIMITS.maxIterations,
    maxTokens: HARNESS_LIMITS.maxTokens,
    timeoutSeconds: HARNESS_LIMITS.timeoutSeconds,
    truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: HARNESS_LIMITS.slidingWindowMessages } } },
    memory: { agentCoreMemoryConfiguration: { arn: memory.memoryArn, retrievalConfig: memoryRetrievalConfig() } },
    tags: tagList({ SystemPromptDigest: textDigest(DEFAULT_SYSTEM_PROMPT) }),
  },
  { dependsOn: [harnessRolePolicy, ...Object.values(gatewayPolicies)] },
);

/** The AgentCore Runtime under the Harness: its id names the runtime log groups. */
const runtimeEnvironment = harness.environment.apply((environment) => {
  const runtime = environment?.agentCoreRuntimeEnvironment;
  if (runtime?.agentRuntimeId === undefined || runtime.agentRuntimeId === "") {
    throw new Error("The Harness state has no environment.agentCoreRuntimeEnvironment.agentRuntimeId, so the log group of the live endpoint cannot be named before it.");
  }
  return { id: runtime.agentRuntimeId, arn: runtime.agentRuntimeArn };
});

/** Created before the endpoint, so AgentCore never creates it first (with no retention). */
export const harnessLogGroups: aws.cloudwatch.LogGroup[] = runtimeLogGroupEndpoints(HARNESS_ENDPOINT_NAME).map(
  (endpoint) =>
    new aws.cloudwatch.LogGroup(`HarnessRuntimeLogs${pascal(endpoint)}`, {
      name: runtimeEnvironment.apply((runtime) => runtimeLogGroupName(runtime.id, endpoint)),
      retentionInDays: AGENT_LOG_RETENTION_DAYS,
    }),
);

export const harnessEndpoint = new awsnative.bedrockagentcore.HarnessEndpoint(
  "AgentHarnessEndpoint",
  {
    harnessId: harness.harnessId,
    endpointName: HARNESS_ENDPOINT_NAME,
    description: `Endpoint the operation worker invokes; follows the Harness version of each deploy (${$app.stage}).`,
    targetVersion: harness.version,
    tags: tagList(),
  },
  { dependsOn: harnessLogGroups },
);

// ---- Links -------------------------------------------------------------------------------------------

/** OperationWorker (infra/operations.ts, late link): InvokeHarness on the harness, its endpoint and its runtime. */
export const Harness = new sst.Linkable(HARNESS_LINK, {
  properties: {
    harnessArn: harness.arn,
    harnessId: harness.harnessId,
    endpointName: HARNESS_ENDPOINT_NAME,
    endpointArn: harnessEndpoint.arn,
    timeoutSeconds: HARNESS_LIMITS.timeoutSeconds,
    maxIterations: HARNESS_LIMITS.maxIterations,
  },
  include: [
    sst.aws.permission({
      actions: [...HARNESS_INVOKE_ACTIONS],
      // One element per ARN (infra/output-arns.ts); without a runtime ARN the third repeats the Harness.
      resources: [harness.arn, harnessEndpoint.arn, $util.all([harness.arn, runtimeEnvironment]).apply(([harnessArn, runtime]) => runtime.arn ?? harnessArn)],
    }),
  ],
});

/** The roles that hold WORLDS (purge, `memory.inspect`): the Memory's id, its namespaces and MEMORY_ADMIN on it. */
export const Agent = new sst.Linkable(AGENT_LINK, {
  properties: {
    memoryId: memory.memoryId,
    memoryArn: memory.memoryArn,
    preferencesNamespace: MEMORY_STRATEGIES.importerPreferences.namespace,
    factsNamespace: MEMORY_STRATEGIES.importerFacts.namespace,
    summaryNamespace: MEMORY_STRATEGIES.operationSummary.namespace,
    eventExpiryDays: MEMORY_EVENT_EXPIRY_DAYS,
  },
  include: [sst.aws.permission({ actions: [...CAPABILITIES.MEMORY_ADMIN.actions], resources: [memory.memoryArn] })],
});
