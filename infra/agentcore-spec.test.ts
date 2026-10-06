// The agent as data (infra/agentcore-spec.ts, docs/build-plan.md WP-23): names, limits and Memory against
// docs/architecture.md §4 and §9, the tool Lambdas against infra/iam-capabilities.ts, the Gateway payloads
// against the Cedar statements, the three roles against §14, and the service facts the spec records against
// the pinned provider and the installed SDK. No AWS account.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../packages/bff/src/agent/system-prompt";
import { findAvoidedWord } from "../packages/bff/src/copy/forbidden";
import { namespaceOf } from "../packages/bff/src/qa-driver/memory-inspect";
import { actorNamespace } from "../packages/bff/src/worlds/memory-purge";
import { GATEWAY_TOOLS, ToolTarget, gatewayActionName, type GatewayToolName } from "../packages/shared/src/tools";
import { gatewayInlinePayloads, gatewayToolSchemas } from "./agent-tool-schemas";
import {
  AGENT_LINK,
  AGENT_LOG_RETENTION_DAYS,
  AGENT_MODEL_ID,
  AGENTCORE_PRINCIPAL,
  GATEWAY_SCHEMA_ROLLOUT,
  GATEWAY_TOOL_NAME,
  HARNESS_ALLOWED_TOOLS,
  HARNESS_API_FORMAT,
  HARNESS_ENDPOINT_NAME,
  HARNESS_GUARDRAIL_SCOPE,
  HARNESS_INVOKE_ACTIONS,
  HARNESS_LIFECYCLE,
  HARNESS_LIMITS,
  HARNESS_MEMORY_ACTIONS,
  MEMORY_EVENT_EXPIRY_DAYS,
  MEMORY_EXCLUSION_INSTRUCTION,
  MEMORY_STRATEGIES,
  TARGET_IGNORED_FIELDS,
  TOOL_FUNCTIONS,
  TOOL_LAMBDAS,
  TRACE_CONTENT_CAPTURE,
  WILDCARD_SIDS,
  agentCoreTrustPolicy,
  agentModelArns,
  agentModelProfileDescription,
  agentModelProfileName,
  agentModelSourceArn,
  agentRoleName,
  gatewayArnPattern,
  gatewayName,
  gatewayRoleStatements,
  gatewayTargetDescription,
  gatewayTargetIgnoreChanges,
  harnessBedrockModelConfig,
  harnessName,
  harnessRoleStatements,
  memoryName,
  memoryRetrievalConfig,
  memoryRoleStatements,
  memoryStrategyArgs,
  policyDocument,
  runtimeLogGroupEndpoints,
  runtimeLogGroupName,
  textDigest,
  toolActions,
  toolHandlerPath,
  toolLinkContracts,
  type AgentStatement,
} from "./agentcore-spec";
import { LAMBDA_CAPABILITIES, actionDrift, expectedActions, type LambdaCapabilities, type LambdaName } from "./iam-capabilities";
import { GATEWAY_TARGETS, cedarPolicies, inputSchemasByAction, schemaProblems } from "./policy-rules";

const APP = "aws-cds-hackathon-poc-legajo";
const STAGE = "poc";
const PLACE = { account: "776805327629", region: "us-east-1" };
const PROFILE_ARN = "arn:aws:bedrock:us-east-1:776805327629:application-inference-profile/abc123";
const root = process.cwd();
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

const architecture = read("docs/architecture.md");
const section = (from: string, to: string): string => architecture.slice(architecture.indexOf(from), architecture.indexOf(to));
const components = section("## 4.", "## 5.");
const gatewaySection = section("### 9.2", "### 9.3");
const memorySection = section("### 9.3", "### 9.4");

/** The number written right after `label` in a docs section (`maxIterations 12` → 12). */
function documented(text: string, label: string): number {
  const match = new RegExp(`${label} (\\d+)`).exec(text);
  if (match?.[1] === undefined) throw new Error(`docs/architecture.md does not state "${label} <n>"`);
  return Number(match[1]);
}

/** Field names of an exported interface of a declaration file. */
function interfaceFields(path: string, name: string): string[] {
  const text = read(path);
  const start = text.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`${path} has no interface ${name}`);
  const body = text.slice(start, text.indexOf("\n}", start));
  return [...body.matchAll(/^ {4}([A-Za-z]+)\??:/gm)].map((match) => match[1] ?? "");
}

/** IAM glob (`*` only) of a resource pattern against a concrete ARN. */
function covers(pattern: string, arn: string): boolean {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`).test(arn);
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

describe("names", () => {
  it("fit the service patterns and the fixed names of docs/architecture.md §9", () => {
    expect(harnessName(APP, STAGE)).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
    expect(memoryName(APP, STAGE)).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    expect(memorySection).toContain(`\`${memoryName(APP, STAGE)}\``);
    expect(gatewayName(APP, STAGE)).toMatch(/^([0-9a-zA-Z][-]?){1,48}$/);
    expect(gatewaySection).toContain(`Gateway \`${gatewayName(APP, STAGE)}\``);
    expect(gatewaySection).toContain(`herramienta del Harness \`${GATEWAY_TOOL_NAME}\``);
    expect(GATEWAY_TOOL_NAME).toMatch(TOOL_NAME);
    expect(HARNESS_ENDPOINT_NAME).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
    for (const purpose of ["harness", "gateway", "memory"] as const) expect(agentRoleName(APP, STAGE, purpose).length).toBeLessThanOrEqual(64);
  });

  it("keeps the runtime inside the fence of the CI bootstrap (harness_<AgentNamePrefix>*)", () => {
    const prefix = /AgentNamePrefix:\n\s+Type: String\n\s+Default: (\S+)/.exec(read("infra/bootstrap/ci-role.yaml"))?.[1];
    expect(prefix).toBeDefined();
    expect(covers(`harness_${prefix ?? "?"}*`, `harness_${harnessName(APP, STAGE)}-Ab12Cd34Ef`)).toBe(true);
  });
});

describe("Harness (docs/architecture.md §4)", () => {
  it("uses the documented model, limits and tools", () => {
    expect(components).toContain(`\`${AGENT_MODEL_ID}\``);
    expect(components).toContain(`\`${HARNESS_API_FORMAT}\``);
    expect(HARNESS_LIMITS).toEqual({
      maxIterations: documented(components, "maxIterations"),
      maxTokens: documented(components, "maxTokens"),
      timeoutSeconds: documented(components, "timeoutSeconds"),
      slidingWindowMessages: documented(components, "sliding_window"),
    });
    expect(components).toContain(`allowedTools: [${HARNESS_ALLOWED_TOOLS.map((tool) => `"${tool}"`).join(", ")}]`);
  });

  it("allows the Gateway only: no built-in shell, file or code interpreter tool", () => {
    expect(HARNESS_ALLOWED_TOOLS).toEqual([`@${GATEWAY_TOOL_NAME}/*`]);
    for (const pattern of HARNESS_ALLOWED_TOOLS) expect(pattern).not.toMatch(/^\*$|builtin|shell|file|code/);
  });

  it("keeps the session lifecycle inside the service range and above one turn", () => {
    for (const value of Object.values(HARNESS_LIFECYCLE)) expect(value).toBeGreaterThanOrEqual(60);
    for (const value of Object.values(HARNESS_LIFECYCLE)) expect(value).toBeLessThanOrEqual(28_800);
    expect(HARNESS_LIFECYCLE.idleRuntimeSessionTimeoutSeconds).toBeGreaterThan(HARNESS_LIMITS.timeoutSeconds);
  });

  it("puts G1 in the model parameters and invokes only the tagged application profile, the global profile it copies and its model", () => {
    const guardrail = { guardrailConfig: { guardrailIdentifier: "g1", guardrailVersion: "1", trace: "enabled" } };
    expect(harnessBedrockModelConfig(PROFILE_ARN, guardrail)).toEqual({ modelId: PROFILE_ARN, apiFormat: "converse_stream", additionalParams: guardrail });
    expect(agentModelProfileName(APP, STAGE)).toBe("aws-cds-hackathon-poc-legajo-poc-sonnet-5-5");
    for (const value of [agentModelProfileName(APP, STAGE), agentModelProfileDescription(APP, STAGE)]) expect(value).toMatch(/^([0-9a-zA-Z:.][ _-]?)+$/);
    expect(agentModelSourceArn(PLACE)).toBe(`arn:aws:bedrock:us-east-1:776805327629:inference-profile/${AGENT_MODEL_ID}`);
    expect(agentModelArns(PLACE, PROFILE_ARN)).toEqual([
      PROFILE_ARN,
      "arn:aws:bedrock:us-east-1:776805327629:inference-profile/global.anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5-5",
    ]);
  });

  it("tags the default prompt, which treats every inbound-* block as data", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("inbound-");
    expect(textDigest(DEFAULT_SYSTEM_PROMPT)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records what the Harness guardrail sees, as the installed SDK declares it", () => {
    const models = read("node_modules/@aws-sdk/client-bedrock-agentcore/dist-types/models/models_0.d.ts");
    const union = /export type HarnessContentBlock = ([^;]+);/.exec(models)?.[1] ?? "";
    const members = [...union.matchAll(/HarnessContentBlock\.(\w+)Member/g)].map((match) => match[1] ?? "").filter((name) => name !== "$Unknown");
    const camel = members.map((name) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`).sort();
    expect(camel).toEqual([...HARNESS_GUARDRAIL_SCOPE.harnessContentBlockMembers].sort());
    expect(camel).not.toContain("guardContent");
  });

  it("lets only the worker invoke it, with both actions of the Linkable", () => {
    const invokers = (Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).filter((fn) => expectedActions(fn).some((action) => action.startsWith("bedrock-agentcore:Invoke")));
    expect(invokers).toEqual(["OperationWorker"]);
    expect(expectedActions("OperationWorker").filter((action) => action.startsWith("bedrock-agentcore:")).sort()).toEqual([...HARNESS_INVOKE_ACTIONS].sort());
  });
});

describe("Memory (docs/architecture.md §9.3)", () => {
  const rows = [...memorySection.matchAll(/^\| [^|]+ \| `(\w+)` \| `([^`]+)` \|/gm)].map((match) => [match[1], match[2]]);

  it("has exactly the three documented strategies, names and namespaces", () => {
    expect(rows).toHaveLength(3);
    expect(Object.entries(MEMORY_STRATEGIES).map(([name, strategy]) => [name, strategy.namespace])).toEqual(rows);
    for (const name of Object.keys(MEMORY_STRATEGIES)) expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    expect(MEMORY_EVENT_EXPIRY_DAYS).toBe(documented(memorySection, "eventExpiryDuration"));
  });

  it("retrieves preferences and facts with topK 5 and the summary with topK 3", () => {
    expect(memorySection).toContain("preferencias y hechos con `topK 5`; resumen con `topK 3`");
    const config = memoryRetrievalConfig();
    expect(Object.keys(config)).toEqual(Object.values(MEMORY_STRATEGIES).map((strategy) => strategy.namespace));
    expect(Object.values(config).map((entry) => entry.topK)).toEqual([5, 5, 3]);
    for (const entry of Object.values(config)) expect(entry.relevanceScore).toBeGreaterThanOrEqual(0);
  });

  it("keys every namespace by the importer actor, as the purge and memory.inspect read them", () => {
    const actorId = "imp-imp-0001-e2";
    for (const strategy of Object.values(MEMORY_STRATEGIES)) expect(strategy.namespace.startsWith("/importers/{actorId}/")).toBe(true);
    expect(namespaceOf("preferences", actorId, undefined)).toBe(MEMORY_STRATEGIES.importerPreferences.namespace.replace("{actorId}", actorId));
    expect(namespaceOf("facts", actorId, undefined)).toBe(MEMORY_STRATEGIES.importerFacts.namespace.replace("{actorId}", actorId));
    expect(namespaceOf("summary", actorId, "s1")).toBe(MEMORY_STRATEGIES.operationSummary.namespace.replace("{actorId}", actorId).replace("{sessionId}", "s1"));
    expect(actorNamespace(actorId)).toBe("/importers/{actorId}/".replace("{actorId}", actorId));
  });
});

describe("[FL-050] sensitive data never reaches long-term memory: the exclusion rules of the three strategies", () => {
  const strategies = memoryStrategyArgs(PROFILE_ARN).map((entry) => entry.customMemoryStrategy);

  it("overrides every prompt of the three custom strategies with the same rules and the agent model", () => {
    expect(strategies.map((strategy) => strategy.name)).toEqual(Object.keys(MEMORY_STRATEGIES));
    const prompts = strategies.flatMap((strategy) => Object.values(strategy.configuration).flatMap((override: object) => Object.values(override) as Array<{ appendToPrompt: string; modelId: string }>));
    expect(prompts).toHaveLength(5);
    for (const prompt of prompts) expect(prompt).toEqual({ appendToPrompt: MEMORY_EXCLUSION_INSTRUCTION, modelId: PROFILE_ARN });
    expect(Object.keys(strategies[0]?.configuration ?? {})).toEqual(["userPreferenceOverride"]);
    expect(Object.keys(strategies[1]?.configuration ?? {})).toEqual(["semanticOverride"]);
    expect(Object.keys(strategies[2]?.configuration ?? {})).toEqual(["summaryOverride"]);
  });

  it("excludes bank data, identifiers, amounts, third parties, documents, tokens and inbound instructions", () => {
    for (const term of ["CUIT", "CUIL", "DNI", "CBU", "CVU", "IBAN", "card numbers", "amounts of money", "third parties", "contents of documents", "session tokens", "instructions", "inbound messages", "[CUIT]", "[TARJETA]"]) {
      expect(MEMORY_EXCLUSION_INSTRUCTION, term).toContain(term);
    }
    expect(findAvoidedWord(MEMORY_EXCLUSION_INSTRUCTION)).toBeUndefined();
  });
});

describe("tool Lambdas (docs/architecture.md §9.2 and §14)", () => {
  const lambdas = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];

  it("run one Lambda per target, each an entry of infra/iam-capabilities.ts with a real handler", () => {
    expect(Object.keys(TOOL_FUNCTIONS)).toEqual(ToolTarget.options);
    expect(lambdas.filter((fn) => fn.startsWith("Tool")).sort()).toEqual(Object.values(TOOL_FUNCTIONS).sort());
    for (const target of ToolTarget.options) {
      const [file, exported] = toolHandlerPath(target).split(/\.(?=handler$)/);
      expect(existsSync(resolve(root, `${file ?? ""}.ts`)), target).toBe(true);
      expect(read(`${file ?? ""}.ts`)).toContain(`export const ${exported ?? ""} = lambdaEntry(`);
    }
  });

  it("budgets every target below half a Harness turn", () => {
    for (const spec of Object.values(TOOL_LAMBDAS)) {
      expect(spec.timeoutSeconds).toBeGreaterThan(0);
      expect(spec.timeoutSeconds).toBeLessThan(HARNESS_LIMITS.timeoutSeconds / 2);
      expect(spec.memoryMb).toBeGreaterThanOrEqual(128);
    }
  });

  it("gets exactly the actions its capabilities declare, through one contract each", () => {
    for (const fn of Object.values(TOOL_FUNCTIONS)) expect(actionDrift(fn, toolActions(fn)), fn).toEqual({ extra: [], missing: [] });
    expect(toolLinkContracts("ToolOperations")).toEqual([]);
    expect(toolLinkContracts("ToolDocuments")).toEqual(["ReaderMock"]);
    expect(toolLinkContracts("ToolFollowups")).toEqual(["Scheduler"]);
    for (const fn of ["ToolMessaging", "ToolHandoff"] as const) expect([...toolLinkContracts(fn)].sort()).toEqual(["EmailSender", "GuardrailG2", "Scheduler", "WhatsAppSender"]);
  });

  it("refuses a capability or a raw action no tool Lambda may hold", () => {
    expect(() => toolLinkContracts("WorldJanitor")).toThrow(/no tool Lambda may hold/);
    expect(() => toolLinkContracts("Bff")).toThrow(/raw actions/);
  });

  it("is invoked by the Gateway role only: no internal role holds lambda:InvokeFunction on a target", () => {
    for (const fn of lambdas) {
      const entry: LambdaCapabilities = LAMBDA_CAPABILITIES[fn];
      expect(entry.fence ?? "", fn).not.toMatch(/Tool(Operations|Documents|Messaging|Followups|Handoff)/);
    }
    const holders = lambdas.filter((fn) => expectedActions(fn).includes("lambda:InvokeFunction"));
    for (const fn of holders.filter((name) => name.startsWith("Tool"))) expect(toolLinkContracts(fn), fn).toContain("ReaderMock");
  });
});

describe("Gateway targets (docs/architecture.md §9.2)", () => {
  it("are named exactly like the Cedar action ids expect", () => {
    expect([...GATEWAY_TARGETS]).toEqual(ToolTarget.options);
    for (const target of GATEWAY_TARGETS) expect(target).toMatch(/^([0-9a-zA-Z][-]?){1,100}$/);
    for (const tool of ToolTarget.options.flatMap((target) => GATEWAY_TOOLS[target] as readonly GatewayToolName[])) expect(gatewayActionName(tool)).toMatch(TOOL_NAME);
  });

  it("carry the schema digest in a description the Gateway accepts", () => {
    for (const target of ToolTarget.options) {
      const { inlinePayload, digest } = gatewayToolSchemas[target];
      expect(inlinePayload.map((tool) => tool.name)).toEqual([...GATEWAY_TOOLS[target]]);
      const description = gatewayTargetDescription(target, inlinePayload.length, digest);
      expect(description.length).toBeLessThanOrEqual(200);
      expect(description).toContain(digest);
    }
  });

  it("ignore the Cloud Control read-back unless a schema rollout names the target", () => {
    expect([...TARGET_IGNORED_FIELDS]).toEqual(["metadataConfiguration", "targetConfiguration", "description"]);
    for (const target of ToolTarget.options) {
      expect(gatewayTargetIgnoreChanges(target)).toEqual(GATEWAY_SCHEMA_ROLLOUT.includes(target) ? ["metadataConfiguration"] : [...TARGET_IGNORED_FIELDS]);
    }
    for (const target of GATEWAY_SCHEMA_ROLLOUT) expect(ToolTarget.options).toContain(target);
  });

  it("match every Cedar statement against the very payloads infra/agentcore.ts deploys", () => {
    const policies = cedarPolicies({ gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:776805327629:gateway/g-1", harnessPrincipalId: "arn:aws:sts::776805327629:assumed-role/h" });
    expect(schemaProblems(policies, inputSchemasByAction(gatewayInlinePayloads))).toEqual([]);
  });
});

describe("runtime log group and content in traces (docs/architecture.md §12)", () => {
  it("names the live endpoint's group, never DEFAULT's, with 30 days of retention", () => {
    expect(runtimeLogGroupEndpoints()).toEqual([HARNESS_ENDPOINT_NAME]);
    expect(() => runtimeLogGroupEndpoints("DEFAULT")).toThrow(/DEFAULT/);
    expect(runtimeLogGroupName("harness_x-Ab12", "live")).toBe("/aws/bedrock-agentcore/runtimes/harness_x-Ab12-live");
    expect(() => runtimeLogGroupName("../x", "live")).toThrow();
    expect(AGENT_LOG_RETENTION_DAYS).toBe(30);
  });

  it("records that no Harness or endpoint field turns content capture off, so retention is what is fixed", () => {
    const fields = [
      ...interfaceFields(TRACE_CONTENT_CAPTURE.checked[0], "HarnessArgs"),
      ...interfaceFields(TRACE_CONTENT_CAPTURE.checked[1], "HarnessEndpointArgs"),
      ...interfaceFields(TRACE_CONTENT_CAPTURE.checked[2], "CreateHarnessRequest"),
      ...interfaceFields(TRACE_CONTENT_CAPTURE.checked[2], "CreateHarnessEndpointRequest"),
    ];
    expect(fields).toContain("executionRoleArn");
    expect(fields.filter((field) => /observab|capture|telemetry|trac|logging|content/i.test(field))).toEqual([]);
    expect(TRACE_CONTENT_CAPTURE).toMatchObject({ captureCanBeTurnedOff: false, decision: "RETENTION", runtimeLogGroupRetentionDays: AGENT_LOG_RETENTION_DAYS });
  });
});

describe("IAM of the agent roles (docs/architecture.md §14)", () => {
  const resources = { modelProfileArn: PROFILE_ARN, gatewayArn: "arn:gateway", memoryArn: "arn:memory", guardrailArn: "arn:g1" };
  const harness = harnessRoleStatements(PLACE, APP, STAGE, resources);
  const bySid = (statements: readonly AgentStatement[], sid: string): AgentStatement | undefined => statements.find((statement) => statement.sid === sid);

  it("gives the Harness the model, G1, the Gateway and the Memory, each on its own resource only", () => {
    expect(bySid(harness, "Model")).toMatchObject({ actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], resources: agentModelArns(PLACE, PROFILE_ARN) });
    expect(bySid(harness, "ModelProfileRead")).toMatchObject({ actions: ["bedrock:GetInferenceProfile"], resources: [PROFILE_ARN] });
    expect(bySid(harness, "GuardrailG1")).toMatchObject({ actions: ["bedrock:ApplyGuardrail"], resources: ["arn:g1"] });
    expect(bySid(harness, "Gateway")).toMatchObject({ actions: ["bedrock-agentcore:InvokeGateway"], resources: ["arn:gateway"] });
    expect(bySid(harness, "Memory")).toMatchObject({ actions: [...HARNESS_MEMORY_ACTIONS], resources: ["arn:memory"] });
    const actions = harness.flatMap((statement) => statement.actions);
    expect(actions).not.toContain("bedrock-agentcore:DeleteEvent");
    expect(actions.filter((action) => !/^(bedrock|bedrock-agentcore|logs|xray|cloudwatch|ecr-public|sts):/.test(action))).toEqual([]);
    expect(actions.filter((action) => /Invoke(Harness|AgentRuntime|Function)|Delete|Put(Item|Object)/.test(action))).toEqual([]);
  });

  it("uses `*` only where the action has no resource-level permission, and fences the runtime logs", () => {
    for (const statement of harness) if (statement.resources.includes("*")) expect(WILDCARD_SIDS, statement.sid).toContain(statement.sid);
    expect(bySid(harness, "Metrics")?.condition).toEqual({ StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } });
    const group = runtimeLogGroupName(`harness_${harnessName(APP, STAGE)}-Ab12Cd34Ef`, HARNESS_ENDPOINT_NAME);
    const logGroupArn = `arn:aws:logs:us-east-1:776805327629:log-group:${group}`;
    expect((bySid(harness, "RuntimeLogGroup")?.resources ?? []).some((pattern) => covers(pattern, logGroupArn))).toBe(true);
    expect((bySid(harness, "RuntimeLogStreams")?.resources ?? []).some((pattern) => covers(pattern, `${logGroupArn}:log-stream:runtime-logs`))).toBe(true);
    expect((bySid(harness, "RuntimeLogGroup")?.resources ?? []).some((pattern) => covers(pattern, "arn:aws:logs:us-east-1:776805327629:log-group:/aws/bedrock-agentcore/runtimes/other-live"))).toBe(false);
  });

  it("lets the Gateway invoke the five targets and evaluate Cedar, nothing else", () => {
    const arns = ToolTarget.options.map((target) => `arn:aws:lambda:us-east-1:776805327629:function:${TOOL_FUNCTIONS[target]}`);
    const statements = gatewayRoleStatements(PLACE, APP, STAGE, arns, "arn:engine");
    expect(bySid(statements, "InvokeToolTargets")).toEqual({ sid: "InvokeToolTargets", actions: ["lambda:InvokeFunction"], resources: arns });
    expect(statements.flatMap((statement) => statement.actions).filter((action) => action.startsWith("lambda:"))).toEqual(["lambda:InvokeFunction"]);
    expect(bySid(statements, "PolicyEngineAuthorization")?.resources).toEqual(["arn:engine", "arn:aws:bedrock-agentcore:us-east-1:776805327629:gateway/aws-cds-hackathon-poc-legajo-poc-*"]);
    expect(memoryRoleStatements(PLACE, PROFILE_ARN)).toEqual([
      { sid: "ExtractionModel", actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], resources: agentModelArns(PLACE, PROFILE_ARN) },
      { sid: "ModelProfileRead", actions: ["bedrock:GetInferenceProfile"], resources: [PROFILE_ARN] },
    ]);
  });

  it("trusts AgentCore of this account only, from the stage's gateways for the Gateway role", () => {
    const trust = JSON.parse(agentCoreTrustPolicy(PLACE, gatewayArnPattern(PLACE, APP, STAGE))) as { Statement: Array<{ Principal: unknown; Condition: unknown }> };
    expect(trust.Statement).toHaveLength(1);
    expect(trust.Statement[0]?.Principal).toEqual({ Service: AGENTCORE_PRINCIPAL });
    expect(trust.Statement[0]?.Condition).toEqual({
      StringEquals: { "aws:SourceAccount": "776805327629" },
      ArnLike: { "aws:SourceArn": "arn:aws:bedrock-agentcore:us-east-1:776805327629:gateway/aws-cds-hackathon-poc-legajo-poc-*" },
    });
    const document = JSON.parse(policyDocument(harness)) as { Version: string; Statement: Array<{ Effect: string }> };
    expect(document.Version).toBe("2012-10-17");
    expect(document.Statement.every((statement) => statement.Effect === "Allow")).toBe(true);
  });
});

describe("Linkables", () => {
  it("give the code the Memory id it reads as Agent", () => {
    for (const file of ["packages/bff/src/worlds/memory-admin.ts", "packages/bff/src/qa-driver/aws-memory.ts"]) {
      expect(read(file)).toContain(`readLinked("${AGENT_LINK}", AgentLink).memoryId`);
    }
    expect(read("infra/agentcore.ts")).toMatch(/new sst\.Linkable\(AGENT_LINK, \{\n {2}properties: \{\n {4}memoryId: memory\.memoryId,/);
  });
});
