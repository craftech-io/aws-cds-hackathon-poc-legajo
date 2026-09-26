import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CEDAR_STATEMENT_IDS, cedarPermitId, cedarSessionId } from "../packages/shared/src/rules";
import { GATEWAY_TOOLS, gatewayActionName, type GatewayToolName, type ToolTarget } from "../packages/shared/src/tools";
import { gatewayInlinePayloads } from "./agent-tool-schemas";
import {
  GATEWAY_TARGETS,
  KILL_SWITCH_ACTIVE,
  MAX_STATEMENT_CHARS,
  allActionIds,
  assumedRoleEntityId,
  cedarPolicies,
  creationPlan,
  evaluateCedar,
  inputSchemasByAction,
  parseStatement,
  policyEngineName,
  policyName,
  schemaProblems,
  unguardedReads,
  type CedarPolicyDefinition,
  type CedarRequest,
  type ToolInputSchemas,
} from "./policy-rules";

const ACCOUNT = "776805327629";
// Worst case of what infra/agentcore.ts can pass: an IAM role name of 64 characters and a Gateway id of 100.
const inputs = {
  gatewayArn: `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:gateway/${"aws-cds-hackathon-poc-legajo-poc-".padEnd(100, "x")}`,
  harnessPrincipalId: assumedRoleEntityId(ACCOUNT, "aws-cds-hackathon-poc-legajo-poc-HarnessExecutionRole".padEnd(64, "z")),
};
const policies = cedarPolicies(inputs);
const byId = (id: string): CedarPolicyDefinition => {
  const found = policies.find((policy) => policy.id === id);
  if (found === undefined) throw new Error(`no policy ${id}`);
  return found;
};

/** Input schemas of the 15 tools as docs/tool-catalog.md writes them (the spec WP-22's zod generates). */
function catalogSchemas(): ToolInputSchemas {
  const catalog = readFileSync(resolve(process.cwd(), "docs/tool-catalog.md"), "utf8");
  const schemas: Record<string, { properties?: Record<string, { type?: string }> }> = {};
  for (const match of catalog.matchAll(/^### `([a-z_]+)`\n[\s\S]*?```json\n([\s\S]*?)\n```/gm)) {
    const parsed = JSON.parse(match[2] ?? "{}") as { input: { properties?: Record<string, { type?: string }> } };
    schemas[gatewayActionName(match[1] as GatewayToolName)] = parsed.input;
  }
  return schemas;
}


const request = (action: string, input: Record<string, unknown>, overrides: Partial<CedarRequest> = {}): CedarRequest => ({
  principal: inputs.harnessPrincipalId,
  action,
  resource: inputs.gatewayArn,
  input,
  ...overrides,
});

/** The smallest input each fence accepts: a session and, on the send tools, the right recipient. */
function validInput(action: string): Record<string, unknown> {
  if (action === "messaging___send_email") return { sessionToken: "ses.turn.1.sig", recipientRole: "SUPPLIER" };
  if (action === "messaging___send_whatsapp") return { sessionToken: "ses.turn.1.sig", recipientRole: "IMPORTER" };
  return { sessionToken: "ses.turn.1.sig" };
}

const decide = (action: string, input: Record<string, unknown>, set: readonly CedarPolicyDefinition[] = policies) => evaluateCedar(set, request(action, input));

describe("statements", () => {
  it("renders every CED-* id of @legajo/shared once, in creation order, with a valid unique name", () => {
    expect(policies.map((policy) => policy.id)).toEqual([...CEDAR_STATEMENT_IDS]);
    for (const policy of policies) {
      expect(policy.name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,47}$/);
      expect(policy.name).toBe(policyName(policy.id));
      expect(policy.statement.startsWith(`// ${policy.id}\n${policy.effect}(\n  principal == AgentCore::IamEntity::"${inputs.harnessPrincipalId}",`)).toBe(true);
      expect(policy.statement).toContain(`resource == AgentCore::Gateway::"${inputs.gatewayArn}"`);
      expect(policy.statement.endsWith(";")).toBe(true);
      expect(policy.enforcementMode).toBe("ACTIVE");
    }
    expect(new Set(policies.map((policy) => policy.name)).size).toBe(policies.length);
    expect(policyEngineName("aws-cds-hackathon-poc-legajo", "poc")).toBe("aws_cds_hackathon_poc_legajo_poc");
  });

  it("permits exactly the 15 Gateway tools of docs/tool-catalog.md, one permit per target (CED-PERMIT-<TARGET>)", () => {
    const permits = policies.filter((policy) => policy.effect === "permit");
    expect(permits.map((policy) => policy.id)).toEqual(GATEWAY_TARGETS.map(cedarPermitId));
    GATEWAY_TARGETS.forEach((target, index) => {
      expect(parseStatement(permits[index]?.statement ?? "").actions).toEqual(GATEWAY_TOOLS[target].map((tool) => gatewayActionName(tool)));
    });
    expect(allActionIds()).toHaveLength(15);
    expect(allActionIds().sort()).toEqual(Object.keys(catalogSchemas()).sort());
  });

  it("stays within the subset the local evaluator understands and rejects anything else", () => {
    for (const policy of policies) expect(() => parseStatement(policy.statement)).not.toThrow();
    const like = byId("CED-NO-APPROVE").statement.replace("context.input has decision", 'context.input.decision like "*"');
    expect(() => parseStatement(like)).toThrow(/Unsupported Cedar term/);
    expect(() => parseStatement("permit(principal, action, resource);")).toThrow(/outside the supported Cedar subset/);
  });
});

describe("engine limits and creation order", () => {
  it("keeps every statement under 10,000 characters once each action is qualified with the Gateway ARN", () => {
    const qualified = (statement: string): string => statement.replace(/AgentCore::Action::"/g, `AgentCore::Action::"${inputs.gatewayArn}/`);
    for (const policy of [...policies, ...cedarPolicies(inputs, { killSwitchActive: true })]) {
      expect(qualified(policy.statement).length, policy.name).toBeLessThan(MAX_STATEMENT_CHARS);
    }
  });

  it("creates the five permits first and every forbid after all of them", () => {
    const plan = creationPlan(policies);
    const permitNames = GATEWAY_TARGETS.map((target) => policyName(cedarPermitId(target)));
    expect(plan.slice(0, 5).map((step) => [step.definition.name, step.after])).toEqual(permitNames.map((name) => [name, []]));
    for (const step of plan.slice(5)) {
      expect(step.definition.effect).toBe("forbid");
      expect(step.after).toEqual(permitNames);
    }
    expect(plan.map((step) => step.definition.name).sort()).toEqual(policies.map((policy) => policy.name).sort());
  });

  it("scopes every forbid to the Harness, the only principal a permit allows", () => {
    for (const policy of policies.filter((candidate) => candidate.effect === "forbid")) {
      expect(parseStatement(policy.statement).principal).toBe(inputs.harnessPrincipalId);
    }
  });

  it("fails on analyzer findings except where the finding is certain by construction", () => {
    const certain = new Set<string>([...GATEWAY_TARGETS.map(cedarPermitId), ...GATEWAY_TARGETS.map(cedarSessionId), "CED-KILL-SWITCH"]);
    for (const policy of policies) expect(policy.validationMode, policy.id).toBe(certain.has(policy.id) ? "IGNORE_ALL_FINDINGS" : "FAIL_ON_ANY_FINDINGS");
  });
});

describe("cited fields: declared in the tool schema and read only behind `has`", () => {
  it("declares every field Cedar cites in the schemas of docs/tool-catalog.md and guards every read", () => {
    expect(schemaProblems(policies, catalogSchemas())).toEqual([]);
    for (const policy of policies) expect(unguardedReads(policy.statement), policy.id).toEqual([]);
  });

  it("declares them in the Gateway schemas generated from zod (npm run tools:build-schemas)", () => {
    expect(schemaProblems(policies, inputSchemasByAction(gatewayInlinePayloads))).toEqual([]);
  });

  it("reports a read without `has`, an undeclared field, a non-string comparison and a tool no permit names", () => {
    const unguarded = byId("CED-EMAIL-SUPPLIER-ONLY");
    const bare = { ...unguarded, statement: unguarded.statement.replace("context.input has recipientRole &&\n  ", "") };
    expect(unguardedReads(bare.statement)).toEqual(["recipientRole"]);

    const schemas = catalogSchemas();
    const approval = schemas["handoff___request_approval"]?.properties ?? {};
    const email = schemas["messaging___send_email"]?.properties ?? {};
    const broken: ToolInputSchemas = {
      ...schemas,
      handoff___request_approval: { properties: Object.fromEntries(Object.entries(approval).filter(([field]) => field !== "decision")) },
      messaging___send_email: { properties: { ...email, recipientRole: { type: "object" } } },
      handoff___approve_dossier: { properties: { sessionToken: { type: "string" } } },
    };
    const problems = schemaProblems([...policies.filter((policy) => policy !== unguarded), bare], broken);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^CED-EMAIL-SUPPLIER-ONLY: context\.input\.recipientRole is read without/),
        expect.stringMatching(/^CED-NO-APPROVE: handoff___request_approval declares no input field "decision"/),
        expect.stringMatching(/^CED-EMAIL-SUPPLIER-ONLY: messaging___send_email\.recipientRole is compared with a string but is object/),
        "Gateway tool handoff___approve_dossier is named by no permit",
      ]),
    );
  });

  it("shows why: a forbid that read an absent field without `has` would let the call through", () => {
    const guarded = byId("CED-EMAIL-SUPPLIER-ONLY");
    const bare = { ...guarded, statement: guarded.statement.replace("context.input has recipientRole &&\n  ", "") };
    const noRole = { sessionToken: "ses.turn.1.sig", kind: "DOCS_REQUEST" };
    expect(decide("messaging___send_email", noRole).decision).toBe("DENY");
    const weakened = decide("messaging___send_email", noRole, [...policies.filter((policy) => policy !== guarded), bare]);
    expect(weakened).toEqual({ decision: "ALLOW", determining: ["CED_PERMIT_MESSAGING"], errors: ["CED_EMAIL_SUPPLIER_ONLY"] });
  });
});

describe("[FL-074] the agent cannot approve (CED-NO-APPROVE)", () => {
  it("denies request_approval whenever `decision` is present, whatever its value", () => {
    for (const decision of ["APPROVED", "approve", "", "READY_FOR_REVIEW"]) {
      const result = decide("handoff___request_approval", { sessionToken: "ses.turn.1.sig", summary: "all documents valid", decision });
      expect(result.decision, decision).toBe("DENY");
      expect(result.determining).toEqual(["CED_NO_APPROVE"]);
    }
    expect(decide("handoff___request_approval", { sessionToken: "ses.turn.1.sig", summary: "all documents valid" }).decision).toBe("ALLOW");
  });

  it("works because `decision` is an optional, documented field of the schema, and no Gateway tool approves", () => {
    const approval = catalogSchemas()["handoff___request_approval"] as { properties?: Record<string, { description?: string }>; required?: string[] };
    expect(approval.properties?.["decision"]?.description).toContain("CED-NO-APPROVE");
    expect(approval.required ?? []).not.toContain("decision");
    expect(allActionIds().some((id) => /___(approve|reopen)_/.test(id))).toBe(false);
    expect(byId("CED-NO-APPROVE").statement).toContain('action == AgentCore::Action::"handoff___request_approval"');
  });
});

describe("[FL-051] [FL-038] injected instructions cannot widen what a tool does", () => {
  it("sends email only to the supplier (CED-EMAIL-SUPPLIER-ONLY)", () => {
    for (const recipientRole of ["IMPORTER", "BROKER", "supplier", "SUPPLIER "]) {
      expect(decide("messaging___send_email", { sessionToken: "ses.turn.1.sig", recipientRole }).determining, recipientRole).toEqual(["CED_EMAIL_SUPPLIER_ONLY"]);
    }
    expect(decide("messaging___send_email", { sessionToken: "ses.turn.1.sig" }).decision).toBe("DENY");
    expect(decide("messaging___send_email", validInput("messaging___send_email")).decision).toBe("ALLOW");
  });

  it("sends WhatsApp only to the importer (CED-WA-IMPORTER-ONLY)", () => {
    expect(decide("messaging___send_whatsapp", { sessionToken: "ses.turn.1.sig", recipientRole: "SUPPLIER" }).determining).toEqual(["CED_WA_IMPORTER_ONLY"]);
    expect(decide("messaging___send_whatsapp", { sessionToken: "ses.turn.1.sig" }).decision).toBe("DENY");
    expect(decide("messaging___send_whatsapp", validInput("messaging___send_whatsapp")).decision).toBe("ALLOW");
  });

  it("never lets the model override the labelled assumptions of the delay risk (CED-RISK-ASSUMPTIONS)", () => {
    const result = decide("followups___estimate_delay_risk", { sessionToken: "ses.turn.1.sig", overrideAssumptions: { freeDaysAtPort: 30 } });
    expect(result).toEqual({ decision: "DENY", determining: ["CED_RISK_ASSUMPTIONS"], errors: [] });
    expect(decide("followups___estimate_delay_risk", { sessionToken: "ses.turn.1.sig" }).decision).toBe("ALLOW");
  });

  it("denies every tool without a sessionToken (CED-SESSION-<TARGET>)", () => {
    for (const action of allActionIds()) {
      const withoutSession = Object.fromEntries(Object.entries(validInput(action)).filter(([field]) => field !== "sessionToken"));
      const result = decide(action, withoutSession);
      expect(result.decision, action).toBe("DENY");
      expect(result.determining, action).toContain(policyName(cedarSessionId(action.split("___")[0] as ToolTarget)));
    }
  });

  it("allows only the Harness, only on this Gateway, only the Gateway tools", () => {
    for (const action of allActionIds()) expect(decide(action, validInput(action)).decision, action).toBe("ALLOW");
    const email = validInput("messaging___send_email");
    expect(evaluateCedar(policies, request("messaging___send_email", email, { principal: assumedRoleEntityId(ACCOUNT, "someone-else") })).decision).toBe("DENY");
    expect(evaluateCedar(policies, request("messaging___send_email", email, { resource: `${inputs.gatewayArn}-other` })).decision).toBe("DENY");
    expect(decide("handoff___approve_dossier", { sessionToken: "ses.turn.1.sig" })).toEqual({ decision: "DENY", determining: [], errors: [] });
  });
});

describe("[FL-099] kill switch (CED-KILL-SWITCH)", () => {
  it("is present and off by default: it denies nothing", () => {
    expect(KILL_SWITCH_ACTIVE).toBe(false);
    const killSwitch = byId("CED-KILL-SWITCH");
    expect(killSwitch.effect).toBe("forbid");
    expect(killSwitch.enforcementMode).toBe("ACTIVE");
    expect(killSwitch.statement.endsWith("\nwhen {\n  false\n};")).toBe(true);
    expect(parseStatement(killSwitch.statement).actions).toEqual(allActionIds());
    for (const action of allActionIds()) expect(decide(action, validInput(action)).determining, action).not.toContain("CED_KILL_SWITCH");
  });

  it("denies every Gateway tool of the Harness once switched on through IaC", () => {
    const switchedOn = cedarPolicies(inputs, { killSwitchActive: true });
    const killSwitch = switchedOn.find((policy) => policy.id === "CED-KILL-SWITCH");
    expect(killSwitch?.statement.endsWith(`resource == AgentCore::Gateway::"${inputs.gatewayArn}"\n);`)).toBe(true);
    expect(killSwitch?.name).toBe(byId("CED-KILL-SWITCH").name);
    for (const action of allActionIds()) {
      const result = evaluateCedar(switchedOn, request(action, validInput(action)));
      expect(result.decision, action).toBe("DENY");
      expect(result.determining, action).toContain("CED_KILL_SWITCH");
    }
  });
});

// Keeps the target of every action id consistent with @legajo/shared (a renamed tool fails here first).
describe("action ids", () => {
  it("are <target>___<tool> for the target that owns the tool", () => {
    for (const target of GATEWAY_TARGETS) for (const tool of GATEWAY_TOOLS[target]) expect(gatewayActionName(tool)).toBe(`${target}___${tool}`);
  });
});
