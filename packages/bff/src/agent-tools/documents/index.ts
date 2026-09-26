// Lambda entry of `ToolDocuments` (docs/architecture.md §9.2): infra/agent-tools.ts points the Function at
// `packages/bff/src/agent-tools/documents/index.handler`. The factory is what the local flows and the tests
// build the target with, over the in-memory connector.
import type { Implementations } from "../common/context";
import { lambdaEntry } from "../common/deps";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { documentsImplementations } from "./handler";
import { DOCUMENTS_TOOLS } from "./schema";

export function createDocumentsTarget(deps: ToolDeps, implementations: Implementations<typeof DOCUMENTS_TOOLS> = documentsImplementations): GatewayTargetRuntime {
  return createToolHandler({ target: "documents", tools: DOCUMENTS_TOOLS, implementations }, deps);
}

export const handler = lambdaEntry(createDocumentsTarget);
