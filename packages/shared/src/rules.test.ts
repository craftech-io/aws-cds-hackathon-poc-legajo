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
  // The quota of a guest world's emails (ADR-0015 §4) is evaluated last; the table of the brief lists
  // the fourteen rules of §5.7 and, once it lists this one too, the comparison is the whole list.
  const WORLD_QUOTA = "CP-WORLD-QUOTA";

  it("are the rules of docs/design-brief.md §5.7, in evaluation order, then CP-WORLD-QUOTA", () => {
    const table = columnTokens(BRIEF, "| # | Regla | Enunciado", { column: 1 });
    expect([...CONTACT_POLICY_RULES]).toEqual(table.includes(WORLD_QUOTA) ? table : [...table, WORLD_QUOTA]);
    expect(CONTACT_POLICY_RULES.at(-1)).toBe(WORLD_QUOTA);
  });

  it("every CP-* the docs cite exists", () => {
    expect(citedIds("CP")).toEqual([...CONTACT_POLICY_RULES].sort());
  });

  it("[FL-111] CP-WORLD-QUOTA is a rule of the closed vocabulary, cited by ADR-0015", () => {
    expect(isRuleId(WORLD_QUOTA)).toBe(true);
    expect(readDoc("docs/adr/0015-alta-publica-de-invitados-y-leads.md")).toContain(`\`${WORLD_QUOTA}\``);
  });
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
  it("are the 16 tools of docs/tool-catalog.md, by target", () => {
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
    expect(GatewayToolName.options).toHaveLength(16);
  });

  it("gateway action names are <target>___<tool>", () => {
    expect(gatewayActionName("send_email")).toBe("messaging___send_email");
    expect(gatewayActionName("request_approval")).toBe("handoff___request_approval");
    expect(toolTargetOf("get_checklist")).toBe("operations");
    expect(GatewayToolName.safeParse("approve_dossier").success).toBe(false);
  });
});
