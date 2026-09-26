// The definitions of the 15 Gateway tools by target, in the order of `GATEWAY_TOOLS`: what the Gateway
// payloads are generated from (gateway-schema.ts) and what the tests walk. Pure, like the schemas: the
// SST program loads it through infra/agent-tool-schemas.ts.
import { GATEWAY_TOOLS, ToolTarget } from "@legajo/shared";
import { DOCUMENTS_TOOLS } from "../documents/schema";
import { FOLLOWUPS_TOOLS } from "../followups/schema";
import { HANDOFF_TOOLS } from "../handoff/schema";
import { MESSAGING_TOOLS } from "../messaging/schema";
import { OPERATIONS_TOOLS } from "../operations/schema";
import type { ToolDefinition } from "./define";

export const TOOL_DEFINITIONS = {
  operations: OPERATIONS_TOOLS,
  documents: DOCUMENTS_TOOLS,
  messaging: MESSAGING_TOOLS,
  followups: FOLLOWUPS_TOOLS,
  handoff: HANDOFF_TOOLS,
} as const satisfies { readonly [T in ToolTarget]: { readonly [K in (typeof GATEWAY_TOOLS)[T][number]]: ToolDefinition<K> } };

/** The definitions of a target in `GATEWAY_TOOLS` order. */
export function definitionsOf(target: ToolTarget): readonly ToolDefinition[] {
  const tools: Readonly<Record<string, ToolDefinition>> = TOOL_DEFINITIONS[target];
  return GATEWAY_TOOLS[target].map((tool) => {
    const definition = tools[tool];
    if (definition === undefined) throw new Error(`no definition for ${target}___${tool}`);
    return definition;
  });
}

/** Every definition, target by target. */
export function allDefinitions(): readonly { readonly target: ToolTarget; readonly definition: ToolDefinition }[] {
  return ToolTarget.options.flatMap((target) => definitionsOf(target).map((definition) => ({ target, definition })));
}
