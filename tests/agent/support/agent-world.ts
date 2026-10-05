// The agent scenarios of Legajo listo (tests/agent, run by `agent-test run`): the local flow world of
// tests/flows with the kit's model-backed Harness in place of the scripted one. The worker, the Gateway
// with the stage's Cedar statements, the tool targets and the AWS fakes are the same; only the model
// differs (Qwen on Ollama by default, USD 0). Prompt, tool schemas and limits are imported from what
// infra deploys, never copied. The folder is outside `npm test` and the root tsconfig: CI never sees it.
import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { createLocalHarness, fromEnv, type CallTool, type LocalHarness, type ToolSpec } from "@craftech/agent-testkit";
import { GatewayToolName, ToolTarget, gatewayActionName } from "@legajo/shared";
import { afterEach, expect } from "vitest";
import { gatewayToolSchemas } from "../../../infra/agent-tool-schemas";
import { HARNESS_LIMITS } from "../../../infra/agentcore-spec";
import { DEFAULT_SYSTEM_PROMPT } from "../../../packages/bff/src/agent/system-prompt";
import type { GuardrailScript } from "../../flows/support/fakes/aws";
import type { LocalGateway } from "../../flows/support/gateway";
import { createFlowWorld, type FlowWorld } from "../../flows/support/world";

/** The Gateway's tools as the model sees them: `<target>___<tool>`, with the deployed inline schema. */
export const AGENT_TOOLS: readonly ToolSpec[] = ToolTarget.options.flatMap((target) =>
  gatewayToolSchemas[target].inlinePayload.map((tool) => ({ name: gatewayActionName(GatewayToolName.parse(tool.name)), description: tool.description, inputSchema: tool.inputSchema as unknown as ToolSpec["inputSchema"] })),
);

/** One tool call through the world's Gateway: Cedar first; a DENY reaches the model as an error result. */
export function gatewayCaller(gateway: LocalGateway): CallTool {
  return async (name, input) => {
    const parsed = GatewayToolName.safeParse(name.includes("___") ? name.split("___").at(-1) : name);
    if (!parsed.success) return { status: "error", output: { error: "UnknownTool", tool: name } };
    const call = await gateway.call(parsed.data, input);
    if (call.cedar.decision === "DENY") return { status: "error", output: { error: "AccessDeniedException", policies: call.cedar.determining } };
    return { status: "success", output: call.output };
  };
}

export interface AgentWorld {
  readonly flow: FlowWorld;
  readonly agent: LocalHarness;
}

/** Registers the `afterEach` that closes the world; `open` builds one with the run's model. */
export function useAgentWorld(): { open(options?: { readonly guardrail?: GuardrailScript; readonly realNow?: string }): Promise<AgentWorld> } {
  let world: FlowWorld | undefined;
  afterEach(() => {
    world?.close();
    world = undefined;
  });
  return {
    async open(options = {}) {
      const env = fromEnv({ label: () => expect.getState().currentTestName });
      if (env === undefined) throw new Error("tests/agent need a model: run them with `agent-test run` (qwen by default).");
      let agent: LocalHarness | undefined;
      world = await createFlowWorld({
        ...(options.guardrail === undefined ? {} : { guardrail: options.guardrail }),
        ...(options.realNow === undefined ? {} : { realNow: options.realNow }),
        agent: (gateway) => {
          agent = createLocalHarness({
            model: env.model,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            tools: AGENT_TOOLS,
            callTool: gatewayCaller(gateway),
            limits: { maxIterations: HARNESS_LIMITS.maxIterations, maxTokens: HARNESS_LIMITS.maxTokens, slidingWindowMessages: HARNESS_LIMITS.slidingWindowMessages },
            budget: env.budget,
            temperature: 0,
            ...(env.recorder === undefined ? {} : { recorder: env.recorder }),
          });
          const harness = agent;
          return async (input) => {
            const { stream } = await harness.invoke(input);
            return { stream: stream as AsyncIterable<InvokeHarnessStreamOutput> };
          };
        },
      });
      if (agent === undefined) throw new Error("the world did not build its Harness");
      return { flow: world, agent };
    },
  };
}

/** Names of the tools a turn called, without the target prefix. */
export const toolsOf = (turn: { readonly calls: ReadonlyArray<{ readonly name: string }> }): string[] => turn.calls.map((call) => call.name.split("___").at(-1) ?? call.name);
