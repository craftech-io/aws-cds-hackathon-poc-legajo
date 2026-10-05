import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GATEWAY_TOOLS, MessageKind, ToolTarget } from "@legajo/shared";
import { EXPECTED_TOOL_COUNT, buildSummary, checkGatewayBuild } from "./build-schemas";
import { TOOL_DEFINITIONS, definitionsOf } from "./catalog";
import { defineTool } from "./define";
import { type GatewaySchemaNode, SUPPORTED_WORDS, buildGatewayPayloads, payloadDigest, toGatewayNode, unsupportedWords } from "./gateway-schema";

const build = buildGatewayPayloads();

interface CatalogNode {
  readonly type?: string;
  readonly properties?: Record<string, CatalogNode>;
  readonly required?: readonly string[];
  readonly items?: CatalogNode;
  readonly description?: string;
}

/** Input schemas as docs/tool-catalog.md writes them, by tool name. */
function catalogInputs(): Record<string, CatalogNode> {
  const catalog = readFileSync(resolve(process.cwd(), "docs/tool-catalog.md"), "utf8");
  const inputs: Record<string, CatalogNode> = {};
  for (const match of catalog.matchAll(/^### `([a-z_]+)`\n[\s\S]*?```json\n([\s\S]*?)\n```/gm)) {
    inputs[match[1] ?? ""] = (JSON.parse(match[2] ?? "{}") as { input: CatalogNode }).input;
  }
  return inputs;
}

function everyNode(node: GatewaySchemaNode, visit: (node: GatewaySchemaNode, path: string) => void, path = "input"): void {
  visit(node, path);
  for (const [name, child] of Object.entries(node.properties ?? {})) everyNode(child, visit, `${path}.${name}`);
  if (node.items !== undefined) everyNode(node.items, visit, `${path}[]`);
}

describe("npm run tools:build-schemas", () => {
  it("generates 5 payloads with the 16 Gateway tools, in the order of GATEWAY_TOOLS, and nothing to fix", () => {
    expect(checkGatewayBuild(build)).toEqual([]);
    expect(Object.keys(build.payloads)).toEqual([...ToolTarget.options]);
    for (const target of ToolTarget.options) expect(build.payloads[target].map((tool) => tool.name)).toEqual([...GATEWAY_TOOLS[target]]);
    expect(EXPECTED_TOOL_COUNT).toBe(16);
    expect(buildSummary(build)).toHaveLength(5);
  });

  it("uses only the words a Gateway schema supports, with a single Gateway type on every node", () => {
    for (const target of ToolTarget.options) {
      for (const tool of build.payloads[target]) {
        expect(unsupportedWords(tool.inputSchema, tool.name)).toEqual([]);
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.description.length).toBeGreaterThan(40);
        everyNode(tool.inputSchema, (node, path) => {
          expect(Object.keys(node).every((key) => (SUPPORTED_WORDS as readonly string[]).includes(key)), `${tool.name} ${path}`).toBe(true);
          expect(["string", "number", "integer", "boolean", "object", "array"], `${tool.name} ${path}`).toContain(node.type);
        });
      }
    }
  });

  it("declares exactly the inputs docs/tool-catalog.md writes: same fields, types and required fields", () => {
    const catalog = catalogInputs();
    for (const target of ToolTarget.options) {
      for (const tool of build.payloads[target]) {
        const expected = catalog[tool.name];
        expect(expected, tool.name).toBeDefined();
        const props = tool.inputSchema.properties ?? {};
        expect(Object.keys(props).sort(), tool.name).toEqual(Object.keys(expected?.properties ?? {}).sort());
        for (const [field, spec] of Object.entries(expected?.properties ?? {})) {
          expect(props[field]?.type, `${tool.name}.${field}`).toBe(spec.type);
          if (spec.items?.type !== undefined) expect(props[field]?.items?.type, `${tool.name}.${field}[]`).toBe(spec.items.type);
        }
        expect([...(tool.inputSchema.required ?? [])].sort(), tool.name).toEqual([...(expected?.required ?? [])].sort());
      }
    }
  });

  it("brings every enum down to the description, while zod still validates the real enum in the Lambda", () => {
    const email = build.payloads.messaging.find((tool) => tool.name === "send_email");
    expect(email?.inputSchema.properties?.["kind"]?.description).toContain("One of: DOCS_REQUEST | REMINDER | CORRECTION_REQUEST | ETA_CHANGE | REPLY.");
    expect(email?.inputSchema.properties?.["recipientRole"]?.description).toContain("Always SUPPLIER.");
    const input = TOOL_DEFINITIONS.messaging.send_email.gatewayInput;
    const base = { sessionToken: `a.b.${"1".repeat(10)}.${"s".repeat(43)}`, recipientRole: "SUPPLIER", text: "Please send the packing list.", refs: {} };
    expect(input.safeParse({ ...base, kind: "REMINDER" }).success).toBe(true);
    for (const kind of MessageKind.options.filter((kind) => !["DOCS_REQUEST", "REMINDER", "CORRECTION_REQUEST", "ETA_CHANGE", "REPLY"].includes(kind))) {
      expect(input.safeParse({ ...base, kind }).success, kind).toBe(false);
    }
    expect(input.safeParse({ ...base, kind: "REPLY", recipientRole: "IMPORTER" }).success).toBe(false);
  });

  it("declares `decision` and `overrideAssumptions` for Cedar (optional, typed, never set) and zod refuses them with any value", () => {
    const approval = build.payloads.handoff.find((tool) => tool.name === "request_approval")?.inputSchema;
    const risk = build.payloads.followups.find((tool) => tool.name === "estimate_delay_risk")?.inputSchema;
    expect(approval?.properties?.["decision"]).toEqual({ type: "string", description: "never set; denied by policy CED-NO-APPROVE" });
    expect(risk?.properties?.["overrideAssumptions"]).toEqual({ type: "object", description: "never set; denied by policy CED-RISK-ASSUMPTIONS" });
    expect(approval?.required).not.toContain("decision");
    expect(risk?.required).not.toContain("overrideAssumptions");
    const token = `a.b.${"1".repeat(10)}.${"s".repeat(43)}`;
    for (const value of ["APPROVED", "", 0, false, {}, null]) {
      expect(TOOL_DEFINITIONS.handoff.request_approval.gatewayInput.safeParse({ sessionToken: token, summary: "Ready.", decision: value }).success).toBe(false);
      expect(TOOL_DEFINITIONS.followups.estimate_delay_risk.gatewayInput.safeParse({ sessionToken: token, overrideAssumptions: value }).success).toBe(false);
    }
    expect(TOOL_DEFINITIONS.handoff.request_approval.deniedFields).toEqual(["decision"]);
  });

  it("fails the build on a word the Gateway cannot take, a tool without schema and a tool of another target", () => {
    const union = defineTool({ name: "get_operation", description: "A tool whose field is a union.", fields: { either: z.union([z.string(), z.number()]), shape: z.union([z.object({ a: z.string() }).strict(), z.object({ b: z.number() }).strict()]) }, callers: [] });
    const broken = buildGatewayPayloads((target) => (target === "operations" ? [union] : target === "handoff" ? [...definitionsOf("handoff"), ...definitionsOf("followups")] : definitionsOf(target)));
    const problems = checkGatewayBuild(broken);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^get_operation\.either: "type" \["string","number"\] is not a single Gateway type$/),
        expect.stringMatching(/^get_operation\.shape: unsupported word "anyOf"$/),
        expect.stringMatching(/^get_operation\.shape: "type" undefined is not a single Gateway type$/),
        "operations___get_dossier: tool without schema",
        "handoff___schedule_followup: not a tool of the handoff target",
        "the Gateway has 13 tools, expected 16",
      ]),
    );
  });
});

describe("folding JSON Schema into the Gateway subset", () => {
  it("turns bounds and constants into sentences and drops what only validates", () => {
    const problems: string[] = [];
    const node = toGatewayNode(
      { type: "object", additionalProperties: false, properties: { a: { type: "string", const: "X", pattern: "^X$", description: "A." }, b: { type: "array", items: { type: "string", maxLength: 9 }, minItems: 1, maxItems: 3 }, c: { type: "integer", minimum: 0, maximum: 5 } }, required: ["a"] },
      "t",
      problems,
    );
    expect(problems).toEqual([]);
    expect(node).toEqual({
      type: "object",
      properties: {
        a: { type: "string", description: "A. Always X." },
        b: { type: "array", description: "At least one item. At most 3 items.", items: { type: "string", description: "At most 9 characters." } },
        c: { type: "integer", description: "At least 0. At most 5." },
      },
      required: ["a"],
    });
  });

  it("gives each target a stable digest that moves with any change of its payload", () => {
    const payload = build.payloads.handoff;
    expect(payloadDigest(payload)).toMatch(/^[0-9a-f]{16}$/);
    expect(payloadDigest(buildGatewayPayloads().payloads.handoff)).toBe(payloadDigest(payload));
    const changed = payload.map((tool, index) => (index === 0 ? { ...tool, description: `${tool.description} ` } : tool));
    expect(payloadDigest(changed)).not.toBe(payloadDigest(payload));
  });
});
