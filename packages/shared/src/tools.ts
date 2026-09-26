// The 15 tools of the AgentCore Gateway, grouped by their 5 Lambda targets (docs/tool-catalog.md,
// docs/design-brief.md §5.3). The zod schemas of each tool live in
// packages/bff/src/agent-tools/<target>/schema.ts; this file only fixes the names so the schemas, the
// Cedar statements (infra/policy-rules.ts) and the audit log agree on the same strings.
import { z } from "zod";

export const ToolTarget = z.enum(["operations", "documents", "messaging", "followups", "handoff"]);
export type ToolTarget = z.infer<typeof ToolTarget>;

export const GATEWAY_TOOLS = {
  operations: ["get_operation", "get_dossier", "assign_responsible", "get_counterpart_profile", "get_checklist", "get_dispatch_status"],
  documents: ["read_document", "create_upload_link"],
  messaging: ["send_whatsapp", "send_email", "propose_supplier_contact"],
  followups: ["schedule_followup", "estimate_delay_risk"],
  handoff: ["escalate_to_broker", "request_approval"],
} as const satisfies Record<ToolTarget, readonly string[]>;

export type GatewayToolName = (typeof GATEWAY_TOOLS)[ToolTarget][number];

export const GatewayToolName = z.enum(ToolTarget.options.flatMap((target) => GATEWAY_TOOLS[target]) as GatewayToolName[]);

const TARGET_BY_TOOL: ReadonlyMap<string, ToolTarget> = new Map(
  ToolTarget.options.flatMap((target) => GATEWAY_TOOLS[target].map((tool) => [tool, target] as const)),
);

export function toolTargetOf(tool: GatewayToolName): ToolTarget {
  const target = TARGET_BY_TOOL.get(tool);
  if (target === undefined) throw new RangeError(`unknown gateway tool ${tool}`);
  return target;
}

/** Name the Gateway (and every Cedar action) gives a tool: `<target>___<tool>`. */
export function gatewayActionName(tool: GatewayToolName): string {
  return `${toolTargetOf(tool)}___${tool}`;
}
