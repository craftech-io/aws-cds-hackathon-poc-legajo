import { describe, expect, it } from "vitest";
import {
  CEDAR_STATEMENT_IDS,
  CONTACT_POLICY_RULES,
  LAMBDA_FENCE_IDS,
  RuleId,
  cedarPermitId,
  cedarSessionId,
  isRuleId,
} from "./rules";
import { columnTokens, readDoc } from "./testing";
import { GATEWAY_TOOLS, GatewayToolName, ToolTarget, gatewayActionName, toolTargetOf } from "./tools";

const BRIEF = readDoc("docs/design-brief.md");
const TOOL_CATALOG = readDoc("docs/tool-catalog.md");
const DOCS = [BRIEF, TOOL_CATALOG, readDoc("docs/architecture.md"), readDoc("docs/flows-catalog.md"), readDoc("CONTEXT.md")].join("\n");

/**
 * Every id with `prefix` cited anywhere in the docs, as a whole word and not a wildcard (`CP-HOURS-*`);
 * `<TARGET>` placeholders expand to the five targets.
 */
function citedIds(prefix: string): string[] {
  const found = new Set<string>();
  for (const match of DOCS.matchAll(new RegExp(`\\b${prefix}-[A-Z0-9<>-]*[A-Z0-9>](?![A-Za-z0-9*-])`, "g"))) {
    const id = match[0];
    if (id.includes("<TARGET>")) for (const target of ToolTarget.options) found.add(id.replace("<TARGET>", target.toUpperCase()));
    else found.add(id);
  }
  return [...found].sort();
}

describe("contact policy rules", () => {
  it("are the rules of docs/design-brief.md §5.7, in evaluation order", () => {
    expect([...CONTACT_POLICY_RULES]).toEqual(columnTokens(BRIEF, "| # | Regla | Enunciado", { column: 1 }));
  });

  // Rules the docs already cite for wave 3 stage A2 (ADR-0015 §4), registered by the work package that builds them.
  const DOCUMENTED_AHEAD = ["CP-WORLD-QUOTA"];

  it("every CP-* the docs cite exists", () => {
    expect(citedIds("CP").filter((id) => !DOCUMENTED_AHEAD.includes(id))).toEqual([...CONTACT_POLICY_RULES].sort());
  });

  it.todo("[WP-50:pending] CP-WORLD-QUOTA is registered in CONTACT_POLICY_RULES and in policy/rules.ts (ADR-0015 §4)");
});

describe("Cedar statements and Lambda fences", () => {
  it("one permit and one session statement per target, then the static fences", () => {
    expect(CEDAR_STATEMENT_IDS.slice(0, 5)).toEqual(ToolTarget.options.map(cedarPermitId));
    expect(CEDAR_STATEMENT_IDS.slice(5, 10)).toEqual(ToolTarget.options.map(cedarSessionId));
    expect(cedarPermitId("messaging")).toBe("CED-PERMIT-MESSAGING");
    expect(cedarSessionId("handoff")).toBe("CED-SESSION-HANDOFF");
  });

  it("match every CED-* and LAM-* the docs cite", () => {
    expect(citedIds("CED")).toEqual([...CEDAR_STATEMENT_IDS].sort());
    expect(citedIds("LAM")).toEqual([...LAMBDA_FENCE_IDS].sort());
  });

  it("rule ids are one closed vocabulary for audit entries", () => {
    expect(isRuleId("CP-WA-24H")).toBe(true);
    expect(isRuleId("CED-NO-APPROVE")).toBe(true);
    expect(isRuleId("LAM-OP-SCOPE")).toBe(true);
    expect(isRuleId("RESP-MATRIX")).toBe(true);
    expect(isRuleId("G1")).toBe(true);
    expect(isRuleId("CP-EVERYTHING")).toBe(false);
    expect(isRuleId(42)).toBe(false);
    expect(new Set(RuleId.options).size).toBe(RuleId.options.length);
  });
});

describe("gateway tools", () => {
  it("are the 15 tools of docs/tool-catalog.md, by target", () => {
    const byTarget: Record<string, string[]> = {};
    let target = "";
    for (const line of TOOL_CATALOG.split("\n")) {
      const section = /^## Target `([a-z]+)`/.exec(line)?.[1];
      if (section !== undefined) target = section;
      else if (line.startsWith("## ")) target = "";
      const tool = /^### `([a-z_]+)`$/.exec(line)?.[1];
      if (tool !== undefined && target !== "") (byTarget[target] ??= []).push(tool);
    }
    expect(byTarget).toEqual(GATEWAY_TOOLS);
    expect(GatewayToolName.options).toHaveLength(15);
  });

  it("gateway action names are <target>___<tool>", () => {
    expect(gatewayActionName("send_email")).toBe("messaging___send_email");
    expect(gatewayActionName("request_approval")).toBe("handoff___request_approval");
    expect(toolTargetOf("get_checklist")).toBe("operations");
    expect(GatewayToolName.safeParse("approve_dossier").success).toBe(false);
  });
});
