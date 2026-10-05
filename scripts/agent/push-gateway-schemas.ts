// Pushes the Gateway tool schemas of the five targets when they changed (ADR-0017 §5). Runs right after
// `sst deploy` in deploy.yml, and by hand with the operator's profile.
//
// The targets ignore `targetConfiguration` in Pulumi (infra/agentcore-spec.ts `gatewayTargetIgnoreChanges`):
// with a Cedar policy engine attached, AgentCore adds the restricted header
// `x-amzn-bedrock-agentcore-policy-session-id` to every target's `metadataConfiguration`, and a Cloud
// Control update sends it back and is refused. `UpdateGatewayTarget` takes the target without
// `metadataConfiguration`, so this script carries the new schema the same way every time.
//
// Idempotent: a target whose live description already carries the digest of the generated payload
// (`gatewayTargetDescription`) is left as it is. The gateway id comes from `.sst/outputs.json`
// (`agentGatewayId`) or `--gateway <id>`; without `--apply` it only prints the plan.
//
//   npx tsx scripts/agent/push-gateway-schemas.ts [--gateway <id>] [--apply]
import { readFileSync } from "node:fs";
import { BedrockAgentCoreControlClient, GetGatewayTargetCommand, ListGatewayTargetsCommand, UpdateGatewayTargetCommand, type ToolDefinition } from "@aws-sdk/client-bedrock-agentcore-control";
import { ToolTarget } from "../../packages/shared/src/tools";
import { gatewayToolSchemas } from "../../infra/agent-tool-schemas";
import { gatewayTargetDescription } from "../../infra/agentcore-spec";

const REGION = "us-east-1";
const READY_TIMEOUT_MS = 120_000;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function gatewayIdOf(): string {
  const fromArg = argValue("--gateway");
  if (fromArg !== undefined) return fromArg;
  const outputs = JSON.parse(readFileSync(".sst/outputs.json", "utf8")) as { agentGatewayId?: string };
  if (outputs.agentGatewayId === undefined || outputs.agentGatewayId === "") throw new Error("no agentGatewayId in .sst/outputs.json: deploy first or pass --gateway <id>");
  return outputs.agentGatewayId;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const gatewayIdentifier = gatewayIdOf();
  const client = new BedrockAgentCoreControlClient({ region: REGION });
  const listed = await client.send(new ListGatewayTargetsCommand({ gatewayIdentifier, maxResults: 50 }));
  let changed = 0;
  for (const target of ToolTarget.options) {
    const summary = (listed.items ?? []).find((item) => item.name === target);
    if (summary?.targetId === undefined) throw new Error(`the gateway has no target ${target}`);
    const live = await client.send(new GetGatewayTargetCommand({ gatewayIdentifier, targetId: summary.targetId }));
    const { inlinePayload, digest } = gatewayToolSchemas[target];
    const description = gatewayTargetDescription(target, inlinePayload.length, digest);
    if (live.description === description) {
      console.log(`push-gateway-schemas: ${target}: up to date (${digest})`);
      continue;
    }
    const lambdaArn = live.targetConfiguration?.mcp?.lambda?.lambdaArn;
    if (lambdaArn === undefined) throw new Error(`${target} has no Lambda target configuration`);
    changed += 1;
    if (!apply) {
      console.log(`push-gateway-schemas: ${target}: would push ${inlinePayload.length} tools (${digest}); live "${live.description ?? ""}"`);
      continue;
    }
    await client.send(
      new UpdateGatewayTargetCommand({
        gatewayIdentifier,
        targetId: summary.targetId,
        name: target,
        description,
        credentialProviderConfigurations: live.credentialProviderConfigurations,
        targetConfiguration: { mcp: { lambda: { lambdaArn, toolSchema: { inlinePayload: inlinePayload as unknown as ToolDefinition[] } } } },
      }),
    );
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const status = (await client.send(new GetGatewayTargetCommand({ gatewayIdentifier, targetId: summary.targetId }))).status;
      if (status === "READY") break;
      if (status === "FAILED" || status === "UPDATE_UNSUCCESSFUL" || Date.now() > deadline) throw new Error(`${target} did not become READY (status ${status})`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    console.log(`push-gateway-schemas: ${target}: pushed ${inlinePayload.length} tools (${digest})`);
  }
  if (!apply && changed > 0) console.log("push-gateway-schemas: run with --apply to push");
}

main().catch((error: unknown) => {
  console.error(`push-gateway-schemas: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
