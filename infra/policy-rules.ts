// Cedar policies of the AgentCore Policy engine (docs/design-brief.md §5.6, docs/architecture.md §9.2,
// docs/build-plan.md WP-09), as plain data: the `CED-*` statements, the checks every statement must pass
// and a local evaluator of the small Cedar subset they are written in (tests and the scripted Harness
// of the local flows use it; the Gateway evaluates the real thing).
//
// What Cedar sees on an AWS_IAM Gateway:
//   principal  AgentCore::IamEntity "arn:aws:sts::<account>:assumed-role/<role>", the Harness execution
//              role, the Gateway's only caller
//   action     AgentCore::Action "<target>___<tool>", one per Gateway tool
//   resource   AgentCore::Gateway "<gatewayArn>"
//   context    only `context.input`, the tool arguments typed from the tool's JSON schema
// Cedar is default-deny and forbid-wins. Whatever depends on the session (operation, recipient,
// trigger, attachments) is checked by the target Lambdas (`LAM-*`); Cedar holds the static fences.
//
// What the engine imposes (docs/architecture.md §16):
//   - a statement may not exceed 10,000 characters once each action is qualified with the Gateway, so
//     the permit and the session forbid are one policy per target;
//   - automated reasoning checks the whole engine: a forbid created while no permit covers its action is
//     "Overly Restrictive", so permits are created first and every forbid depends on all of them
//     (`creationPlan`, applied by infra/policy.ts);
//   - each statement is validated against the Gateway's tool schemas, so every field it cites must be
//     declared there (`schemaProblems`, run by infra/policy.ts at deploy time on the generated schemas);
//   - reading an absent field is an evaluation error and Cedar skips an erroring policy: a forbid that
//     read a field without `context.input has <field>` first would fall through to the permit.
//
// Tool names and statement ids come from @legajo/shared, the same strings the audit log and the
// console use. No SST dependency: policy-rules.test.ts checks all of this without an AWS account.
import { cedarPermitId, cedarSessionId, type CedarStatementId } from "../packages/shared/src/rules";
import { GATEWAY_TOOLS, ToolTarget, gatewayActionName, type GatewayToolName } from "../packages/shared/src/tools";

/** Gateway targets in chain order; each `GatewayTarget` must be named exactly like this. */
export const GATEWAY_TARGETS: readonly ToolTarget[] = ToolTarget.options;

/**
 * CED-KILL-SWITCH. The policy always exists; while this is `false` its condition is `false` and it
 * denies nothing. Turning the agent off is an IaC change (this constant to `true`, through CI): the
 * condition goes away and every Gateway call of the Harness is denied. Never a console action.
 */
export const KILL_SWITCH_ACTIVE = false;

/** Engine limit per statement, once every action is qualified with the Gateway ARN. */
export const MAX_STATEMENT_CHARS = 10_000;

export type CedarEffect = "permit" | "forbid";
/** Whether a policy takes part in the decision (`ACTIVE`) or is only traced (`LOG_ONLY`). */
export type CedarEnforcementMode = "ACTIVE" | "LOG_ONLY";
/** How the engine treats analyzer findings when the policy is created or updated. */
export type CedarValidationMode = "FAIL_ON_ANY_FINDINGS" | "IGNORE_ALL_FINDINGS";

export interface CedarPolicyDefinition {
  readonly id: CedarStatementId;
  /** Resource name in the engine: `^[A-Za-z][A-Za-z0-9_]*$`, at most 48 characters, unique. */
  readonly name: string;
  readonly effect: CedarEffect;
  readonly description: string;
  readonly statement: string;
  readonly enforcementMode: CedarEnforcementMode;
  readonly validationMode: CedarValidationMode;
}

export interface CedarPolicyInputs {
  /** ARN of the Gateway the policies protect. */
  readonly gatewayArn: string;
  /** Cedar entity id of the Harness execution role (`assumedRoleEntityId`). */
  readonly harnessPrincipalId: string;
}

export interface CedarPolicyOptions {
  readonly killSwitchActive?: boolean;
}

/** Entity id Cedar gives an assumed IAM role, stable across session names. */
export function assumedRoleEntityId(accountId: string, roleName: string): string {
  return `arn:aws:sts::${accountId}:assumed-role/${roleName}`;
}

/** `CED-NO-APPROVE` → `CED_NO_APPROVE`, the only characters a Policy name accepts. */
export function policyName(id: CedarStatementId): string {
  return id.replace(/-/g, "_");
}

/** Name of the engine: `^[A-Za-z][A-Za-z0-9_]*$`, at most 48 characters. */
export function policyEngineName(app: string, stage: string): string {
  return `${app}_${stage}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48);
}

/** Every Gateway action id (`<target>___<tool>`), in target order. */
export function allActionIds(): string[] {
  return GATEWAY_TARGETS.flatMap((target) => GATEWAY_TOOLS[target].map((tool) => gatewayActionName(tool)));
}

// ---- Rendering -------------------------------------------------------------------------------

export type CedarTerm = { readonly kind: "has"; readonly field: string } | { readonly kind: "eq"; readonly field: string; readonly value: string } | { readonly kind: "false" };

export interface CedarCondition {
  readonly kind: "when" | "unless";
  /** Joined with `&&`, evaluated left to right with short-circuit. */
  readonly terms: readonly CedarTerm[];
}

const has = (field: string): CedarTerm => ({ kind: "has", field });
const eq = (field: string, value: string): CedarTerm => ({ kind: "eq", field, value });

function renderTerm(term: CedarTerm): string {
  if (term.kind === "false") return "false";
  return term.kind === "has" ? `context.input has ${term.field}` : `context.input.${term.field} == "${term.value}"`;
}

function renderActions(tools: readonly GatewayToolName[]): string {
  const [only] = tools;
  if (tools.length === 1 && only !== undefined) return `action == AgentCore::Action::"${gatewayActionName(only)}"`;
  return `action in [\n${tools.map((tool) => `    AgentCore::Action::"${gatewayActionName(tool)}"`).join(",\n")}\n  ]`;
}

function render(id: CedarStatementId, effect: CedarEffect, inputs: CedarPolicyInputs, tools: readonly GatewayToolName[], condition?: CedarCondition): string {
  const scope = `principal == AgentCore::IamEntity::"${inputs.harnessPrincipalId}",\n  ${renderActions(tools)},\n  resource == AgentCore::Gateway::"${inputs.gatewayArn}"`;
  const body = condition === undefined ? "" : `\n${condition.kind} {\n  ${condition.terms.map(renderTerm).join(" &&\n  ")}\n}`;
  return `// ${id}\n${effect}(\n  ${scope}\n)${body};`;
}

const ALL_TOOLS: readonly GatewayToolName[] = GATEWAY_TARGETS.flatMap((target) => GATEWAY_TOOLS[target]);

/**
 * The Cedar policies, permits first. Every statement is scoped to the Gateway ARN (so the engine
 * validates it against that Gateway's schemas) and every forbid names the Harness principal: it is the
 * only principal a permit allows, so the scope changes no decision, and the analyzer does not check
 * principal types that no permit covers.
 */
export function cedarPolicies(inputs: CedarPolicyInputs, options: CedarPolicyOptions = {}): CedarPolicyDefinition[] {
  const killSwitchActive = options.killSwitchActive ?? KILL_SWITCH_ACTIVE;
  const policy = (
    id: CedarStatementId,
    effect: CedarEffect,
    tools: readonly GatewayToolName[],
    description: string,
    validationMode: CedarValidationMode,
    condition?: CedarCondition,
  ): CedarPolicyDefinition => ({
    id,
    name: policyName(id),
    effect,
    description,
    statement: render(id, effect, inputs, tools, condition),
    enforcementMode: "ACTIVE",
    validationMode,
  });

  const permits = GATEWAY_TARGETS.map((target) =>
    // An unconditional allowlist reads "overly permissive" until the forbids that narrow it exist, and
    // those need it first. Schema validation still runs; the forbids fail on any finding.
    policy(cedarPermitId(target), "permit", GATEWAY_TOOLS[target], `Only the Harness role may call the ${target} tools, and only these; anything else falls to default deny.`, "IGNORE_ALL_FINDINGS"),
  );
  const sessions = GATEWAY_TARGETS.map((target) =>
    // Every Gateway schema already requires sessionToken, so the analyzer may call this forbid
    // ineffective; it stays as defense in depth should a schema ever lose the field.
    policy(cedarSessionId(target), "forbid", GATEWAY_TOOLS[target], `A ${target} tool call must carry the signed sessionToken; identity never comes from what the model writes.`, "IGNORE_ALL_FINDINGS", {
      kind: "unless",
      terms: [has("sessionToken")],
    }),
  );

  return [
    ...permits,
    ...sessions,
    policy("CED-EMAIL-SUPPLIER-ONLY", "forbid", ["send_email"], "send_email only ever goes to the supplier; the importer is reached by WhatsApp.", "FAIL_ON_ANY_FINDINGS", {
      kind: "unless",
      terms: [has("recipientRole"), eq("recipientRole", "SUPPLIER")],
    }),
    policy("CED-WA-IMPORTER-ONLY", "forbid", ["send_whatsapp"], "send_whatsapp only ever goes to the importer; the supplier is reached by email.", "FAIL_ON_ANY_FINDINGS", {
      kind: "unless",
      terms: [has("recipientRole"), eq("recipientRole", "IMPORTER")],
    }),
    policy("CED-NO-APPROVE", "forbid", ["request_approval"], "The agent never decides an approval: request_approval with `decision` is denied (ADR-0010).", "FAIL_ON_ANY_FINDINGS", {
      kind: "when",
      terms: [has("decision")],
    }),
    policy("CED-RISK-ASSUMPTIONS", "forbid", ["estimate_delay_risk"], "The agent never overrides the firm's labelled assumptions of the delay risk.", "FAIL_ON_ANY_FINDINGS", {
      kind: "when",
      terms: [has("overrideAssumptions")],
    }),
    // Unconditional forbid when active ("denies everything"), never-applying when not: either way the
    // analyzer has a finding, and that is the point.
    policy(
      "CED-KILL-SWITCH",
      "forbid",
      ALL_TOOLS,
      `Kill switch, ${killSwitchActive ? "ACTIVE: every Gateway call of the Harness is denied" : "off: denies nothing until KILL_SWITCH_ACTIVE is true in infra/policy-rules.ts"}.`,
      "IGNORE_ALL_FINDINGS",
      killSwitchActive ? undefined : { kind: "when", terms: [{ kind: "false" }] },
    ),
  ];
}

export interface PolicyCreationStep {
  readonly definition: CedarPolicyDefinition;
  /** Names of the policies this one must be created after. */
  readonly after: readonly string[];
}

/** Permits first and independent; every forbid after all the permits. */
export function creationPlan(policies: readonly CedarPolicyDefinition[]): PolicyCreationStep[] {
  const permits = policies.filter((policy) => policy.effect === "permit");
  const permitNames = permits.map((policy) => policy.name);
  return [
    ...permits.map((definition) => ({ definition, after: [] })),
    ...policies.filter((policy) => policy.effect === "forbid").map((definition) => ({ definition, after: permitNames })),
  ];
}

// ---- Parsing the rendered subset ----------------------------------------------------------------

export interface ParsedStatement {
  readonly id: string;
  readonly effect: CedarEffect;
  readonly principal: string;
  readonly actions: readonly string[];
  readonly resource: string;
  readonly condition?: CedarCondition;
}

const STATEMENT =
  /^\/\/ (CED-[A-Z-]+)\n(permit|forbid)\(\n {2}principal == AgentCore::IamEntity::"([^"]+)",\n {2}(action == AgentCore::Action::"[^"]+"|action in \[\n[^\]]+\n {2}\]),\n {2}resource == AgentCore::Gateway::"([^"]+)"\n\)(?:\n(when|unless) \{\n([\s\S]+?)\n\})?;$/;

function parseTerm(text: string): CedarTerm {
  if (text === "false") return { kind: "false" };
  const presence = /^context\.input has ([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  if (presence?.[1] !== undefined) return has(presence[1]);
  const equality = /^context\.input\.([A-Za-z_][A-Za-z0-9_]*) == "([^"]*)"$/.exec(text);
  if (equality?.[1] !== undefined && equality[2] !== undefined) return eq(equality[1], equality[2]);
  throw new Error(`Unsupported Cedar term "${text}": only \`context.input has f\`, \`context.input.f == "v"\` and \`false\`.`);
}

/** Parses a statement rendered by `cedarPolicies`; anything outside that subset throws. */
export function parseStatement(statement: string): ParsedStatement {
  const match = STATEMENT.exec(statement);
  if (match === null) throw new Error(`Statement outside the supported Cedar subset:\n${statement}`);
  const [, id = "", effect = "", principal = "", actions = "", resource = "", kind, body] = match;
  const condition: CedarCondition | undefined =
    kind === "when" || kind === "unless" ? { kind, terms: (body ?? "").split("&&").map((term) => parseTerm(term.trim())) } : undefined;
  return {
    id,
    effect: effect === "permit" ? "permit" : "forbid",
    principal,
    actions: [...actions.matchAll(/AgentCore::Action::"([^"]+)"/g)].map((action) => action[1] ?? ""),
    resource,
    ...(condition === undefined ? {} : { condition }),
  };
}

// ---- Local evaluation ------------------------------------------------------------------------------

export interface CedarRequest {
  readonly principal: string;
  readonly action: string;
  readonly resource: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface CedarDecision {
  readonly decision: "ALLOW" | "DENY";
  /** Names of the policies that decided (the forbids that applied, or the permits). */
  readonly determining: readonly string[];
  /** Names of the policies skipped because their condition failed to evaluate. */
  readonly errors: readonly string[];
}

function conditionHolds(terms: readonly CedarTerm[], input: Readonly<Record<string, unknown>>): boolean | "error" {
  for (const term of terms) {
    if (term.kind === "false") return false;
    const present = Object.hasOwn(input, term.field);
    if (term.kind === "has" && !present) return false;
    if (term.kind === "eq" && !present) return "error";
    if (term.kind === "eq" && input[term.field] !== term.value) return false;
  }
  return true;
}

/** Cedar's decision for the policies that are `ACTIVE`: forbid wins, then permit, else default deny. */
export function evaluateCedar(policies: readonly CedarPolicyDefinition[], request: CedarRequest): CedarDecision {
  const applied: Record<CedarEffect, string[]> = { permit: [], forbid: [] };
  const errors: string[] = [];
  for (const policy of policies) {
    if (policy.enforcementMode !== "ACTIVE") continue;
    const parsed = parseStatement(policy.statement);
    if (parsed.principal !== request.principal || parsed.resource !== request.resource || !parsed.actions.includes(request.action)) continue;
    const holds = parsed.condition === undefined ? true : conditionHolds(parsed.condition.terms, request.input);
    if (holds === "error") {
      errors.push(policy.name);
      continue;
    }
    if (parsed.condition === undefined || (parsed.condition.kind === "when") === holds) applied[parsed.effect].push(policy.name);
  }
  if (applied.forbid.length > 0) return { decision: "DENY", determining: applied.forbid, errors };
  return { decision: applied.permit.length > 0 ? "ALLOW" : "DENY", determining: applied.permit, errors };
}

// ---- Checks against the Gateway schemas ---------------------------------------------------------------

export interface ToolInputSchema {
  readonly properties?: Readonly<Record<string, { readonly type?: string }>>;
}

/** Input schema of every Gateway action, keyed by action id (`<target>___<tool>`). */
export type ToolInputSchemas = Readonly<Record<string, ToolInputSchema>>;

/** One entry of a target's `inlinePayload`, as far as Cedar cares. */
export interface GatewayToolSchema {
  readonly name: string;
  readonly inputSchema: ToolInputSchema;
}

export function inputSchemasByAction(payloads: Readonly<Record<ToolTarget, readonly GatewayToolSchema[]>>): ToolInputSchemas {
  const schemas: Record<string, ToolInputSchema> = {};
  for (const target of GATEWAY_TARGETS) for (const tool of payloads[target]) schemas[`${target}___${tool.name}`] = tool.inputSchema;
  return schemas;
}

/** Fields a statement reads (`context.input.<field> == …`) with no earlier `has` of the same condition. */
export function unguardedReads(statement: string): string[] {
  const guarded = new Set<string>();
  const unguarded: string[] = [];
  for (const term of parseStatement(statement).condition?.terms ?? []) {
    if (term.kind === "has") guarded.add(term.field);
    else if (term.kind === "eq" && !guarded.has(term.field)) unguarded.push(term.field);
  }
  return unguarded;
}

/**
 * Everything the engine would reject or that would silently weaken a fence: a read without `has`, an
 * action without a Gateway schema, a cited field the schema does not declare, a string comparison on a
 * field that is not a string, and a Gateway tool that no permit names.
 */
export function schemaProblems(policies: readonly CedarPolicyDefinition[], schemas: ToolInputSchemas): string[] {
  const problems: string[] = [];
  const permitted = new Set<string>();
  for (const policy of policies) {
    const parsed = parseStatement(policy.statement);
    if (parsed.effect === "permit") for (const action of parsed.actions) permitted.add(action);
    for (const field of unguardedReads(policy.statement)) problems.push(`${policy.id}: context.input.${field} is read without "context.input has ${field}" first`);
    for (const action of parsed.actions) {
      const properties = schemas[action]?.properties;
      if (properties === undefined) {
        problems.push(`${policy.id}: no Gateway input schema for ${action}`);
        continue;
      }
      for (const term of parsed.condition?.terms ?? []) {
        if (term.kind === "false") continue;
        const property = properties[term.field];
        if (property === undefined) problems.push(`${policy.id}: ${action} declares no input field "${term.field}"`);
        else if (term.kind === "eq" && property.type !== "string") problems.push(`${policy.id}: ${action}.${term.field} is compared with a string but is ${property.type ?? "untyped"}`);
      }
    }
  }
  for (const action of Object.keys(schemas)) if (!permitted.has(action)) problems.push(`Gateway tool ${action} is named by no permit`);
  return problems;
}
