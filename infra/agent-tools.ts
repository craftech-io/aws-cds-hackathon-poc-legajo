// The five tool Lambdas of the agent, one per Gateway target (docs/architecture.md §9.2 and §14,
// docs/tool-catalog.md, docs/build-plan.md WP-23): ToolOperations, ToolDocuments, ToolMessaging,
// ToolFollowups and ToolHandoff. Each one runs `packages/bff/src/agent-tools/<target>/index.handler`,
// the `createToolHandler` wrapper of WP-22 over that target's tools. Runtime (Node 22), architecture
// (arm64) and log retention come from the $transform of sst.config.ts; timeout and memory from
// TOOL_LAMBDAS of infra/agentcore-spec.ts.
//
// Least privilege (infra/iam-capabilities.ts, the test compares). Every target links its tables and
// buckets through `storageLinks` and SessionTokenKey (the wrapper verifies the sessionToken with its
// `session` subkey). The rest comes from the capabilities it holds, one Linkable contract each
// (`toolLinkContracts`): PIPELINE brings G2, the SYSTEM email sender, the WhatsApp sender and the timers
// (ToolMessaging, ToolHandoff); TIMERS the timers (ToolFollowups); MOCK_READER the reader mock
// (ToolDocuments), whose resource side is `grantMockInvoke`. A linked table grants `dynamodb:*` on it (SST
// has no read-only link): the "read" of the capabilities is enforced by the connector methods each tool
// calls. The Scheduler Linkable arrives late (infra/late-links.ts): infra/scheduler.ts imports modules
// sst.config.ts evaluates after this one.
//
// Who may invoke a target (LAM-CALLER, docs/design-brief.md §5.6). Each target's resource policy names the
// Gateway role, the Gateway's only way in. No internal role invokes a target: the worker, the console and
// the QaDriver import the handlers they call in process (docs/tool-catalog.md, "Principales"), and no
// Lambda of infra/iam-capabilities.ts holds lambda:InvokeFunction on a target (the test holds this).
// Within one account an identity policy alone also invokes, so that absence is the fence that counts.
//
// Cost: per invocation; nothing bills while the agent is idle.
//
// Verify:
//   aws --profile craftech-demos lambda get-function-configuration --function-name <ToolX physical name>
//     → Timeout and MemorySize of TOOL_LAMBDAS, no secret in Environment
//   aws --profile craftech-demos lambda get-policy --function-name <ToolX physical name>
//     → lambda:InvokeFunction for …-poc-gateway (and, on ToolDocuments' reader mock, its pair of permissions)

import { ToolTarget } from "../packages/shared/src/tools";
import { TOOL_FUNCTIONS, TOOL_LAMBDAS, toolHandlerPath, toolLinkContracts, type ToolLinkContract } from "./agentcore-spec";
import { gatewayRole } from "./agentcore-iam";
import { GuardrailG2 } from "./guardrail";
import type { LambdaName } from "./iam-capabilities";
import { lateLinks, links, type LinkList } from "./late-links";
import { emailLinks } from "./messaging-email";
import { sendWhatsAppPermissions, whatsAppSenderLinks } from "./messaging-whatsapp";
import { grantMockInvoke, mockLinks } from "./mocks";
import { SessionTokenKey } from "./secrets";
import { storageLinks } from "./storage";

const schedulerLinks: LinkList = lateLinks("agent-tools", "scheduler", () => import("./scheduler"), ["Scheduler"]);

function contractLinks(fn: LambdaName, contract: ToolLinkContract): $util.Input<unknown[]> {
  switch (contract) {
    case "GuardrailG2":
      return [GuardrailG2];
    case "EmailSender":
      return emailLinks(fn);
    case "WhatsAppSender":
      return whatsAppSenderLinks;
    case "Scheduler":
      return schedulerLinks;
    case "ReaderMock":
      return mockLinks(fn);
  }
}

function toolFunction(target: ToolTarget): sst.aws.Function {
  const fn = TOOL_FUNCTIONS[target];
  const spec = TOOL_LAMBDAS[target];
  const contracts = toolLinkContracts(fn);
  return new sst.aws.Function(fn, {
    handler: toolHandlerPath(target),
    description: spec.description,
    timeout: `${spec.timeoutSeconds} seconds`,
    memory: `${spec.memoryMb} MB`,
    link: links([...storageLinks(fn), SessionTokenKey], ...contracts.map((contract) => contractLinks(fn, contract))),
    // SendWhatsAppMessage on the secret's phone number id; no statement while it is not connected.
    ...(contracts.includes("WhatsAppSender") ? { permissions: sendWhatsAppPermissions } : {}),
  });
}

/** The five target Lambdas, in the order infra/agentcore.ts chains their `GatewayTarget`s. */
export const toolFunctions = Object.fromEntries(ToolTarget.options.map((target) => [target, toolFunction(target)])) as Readonly<Record<ToolTarget, sst.aws.Function>>;

/** Resource side of MOCK_READER (infra/mocks.ts): the pair of permissions on ReaderMock for each tool that reads. */
export const toolReaderGrants: aws.lambda.Permission[] = ToolTarget.options
  .filter((target) => toolLinkContracts(TOOL_FUNCTIONS[target]).includes("ReaderMock"))
  .flatMap((target) => grantMockInvoke(TOOL_FUNCTIONS[target], toolFunctions[target]));

/** Resource policy of each target: the Gateway role, its only invoker. */
export const toolGatewayInvokePermissions: Readonly<Record<ToolTarget, aws.lambda.Permission>> = Object.fromEntries(
  ToolTarget.options.map((target) => [
    target,
    new aws.lambda.Permission(`${TOOL_FUNCTIONS[target]}InvokeByGateway`, {
      action: "lambda:InvokeFunction",
      function: toolFunctions[target].name,
      principal: gatewayRole.arn,
    }),
  ]),
) as Record<ToolTarget, aws.lambda.Permission>;
