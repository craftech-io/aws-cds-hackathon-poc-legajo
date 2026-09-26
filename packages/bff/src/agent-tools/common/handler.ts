// `createToolHandler`: the one wrapper every Gateway target runs its tools through (docs/tool-catalog.md
// "Convenciones", docs/design-brief.md §5.6). In order, for every call:
//
//   1. the tool is one of this target's (the Gateway names it `<target>___<tool>` in the client context);
//   2. `sessionToken` XOR `caller` (`LAM-CALLER`): a caller is refused next to a token and from the Gateway;
//   3. the session is verified (signature, 15 minutes, turn still open) and the operation, firm, parties,
//      clock and trigger are read from it; a direct caller names its operation, the console only one of
//      its own firm, and only the callers docs/tool-catalog.md lists for the tool are admitted;
//   4. the input is parsed strict (`LAM-STRICT`): an undeclared key, a value out of the real enum or a
//      field a Cedar forbid reads (`decision`, `overrideAssumptions`) → `INVALID`;
//   5. the turn's trigger allows the call (`LAM-TRIGGER`) and every id of the input belongs to the
//      operation (`LAM-OP-SCOPE`);
//   6. the implementation runs; whatever it throws becomes the `{ok: false, error}` envelope;
//   7. the output of a Harness call is written to `Runtime/TURN#<turnId>/RESULT#<tool>#<seq>`, the
//      grounding source of G2 and of the outbound verification. A failure is not a fact and is not written.
//
// Every refusal with an authentic scope is audited `DENY` with its rule; a forged or expired token names
// no firm and leaves only a log line. Nothing here throws.
import { z } from "zod";
import {
  ERROR_REASON,
  GATEWAY_TOOLS,
  type GatewayToolName,
  type RuleId,
  ToolError,
  ToolFailureSchema,
  type ToolFailure,
  type ToolTarget,
  fail,
  toToolFailure,
} from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import { worldClock } from "../../lib/clock";
import type { SecretKey } from "../../lib/crypto";
import { type Logger, correlationIdFrom, redactText } from "../../lib/log";
import { type AuditEntry, type Implementations, type ToolContext, type ToolResponse, actorOf, auditorOf, toolAction } from "./context";
import { PRINCIPAL_KEYS, type ToolDefinition, deniedFieldOf } from "./define";
import { GATEWAY_TOOL_SEPARATOR, type LambdaContextLike, PRINCIPAL_REASON, type PrincipalClaim, type ToolPrincipal, claimOf, gatewayMarksOf, resolveToolSession } from "./principal";
import { type ToolScope, connectorLookups, scopeViolation, toolScope } from "./scope";

export interface ToolDeps {
  readonly connector: Connector;
  /** HKDF `session` subkey; read per call so a missing secret fails the call, not the cold start. */
  readonly sessionKey: () => SecretKey;
  /** Real time: token expiry, `atReal` stamps and the real side of a world clock. */
  readonly wallClock: () => Date;
  readonly loggerFor: (correlationId: string) => Logger;
}

/** The definitions of a target: exactly its tools of `GATEWAY_TOOLS`, each under its own name. */
export type TargetTools<T extends ToolTarget> = { readonly [K in (typeof GATEWAY_TOOLS)[T][number]]: ToolDefinition<K> };

export interface TargetSpec<T extends ToolTarget, Tools extends TargetTools<T>> {
  readonly target: T;
  readonly tools: Tools;
  readonly implementations: Implementations<Tools>;
}

export interface GatewayTargetRuntime {
  readonly target: ToolTarget;
  /** Lambda entry: a Gateway call (event = arguments, marks in the client context) or `{tool, input}`. */
  handle(event: unknown, context?: LambdaContextLike): Promise<ToolResponse>;
  /** In-process call (worker, console): the same checks as a Lambda invocation without Gateway marks. */
  invoke(tool: string, input: unknown): Promise<ToolResponse>;
}

/** `reason` of the wrapper's own refusals (the model only sees `code` and `message`). */
export const FENCE_REASON = {
  VALIDATION: "VALIDATION",
  OUT_OF_SCOPE: ERROR_REASON.OPERATION_NOT_IN_SESSION,
  INPUT_TOO_LARGE: "INPUT_TOO_LARGE",
  TRIGGER_NOT_ALLOWED: "TRIGGER_NOT_ALLOWED",
  TURN_CLOSED: "TURN_CLOSED",
  CROSS_FIRM: ERROR_REASON.CROSS_FIRM,
} as const;

/** Bounds of the field names a refusal for invalid input reports. */
const MAX_PATH = 64;
const MAX_PATHS = 10;

const DirectLambdaEvent = z.object({ tool: z.string().min(1).max(64), input: z.record(z.string(), z.unknown()) }).strict();

interface Origin {
  readonly fromGateway: boolean;
  readonly requestId?: string;
}

interface Resolved {
  readonly scope: ToolScope;
  readonly principal: ToolPrincipal;
  readonly correlationId: string;
  readonly log: Logger;
}

interface Refusal {
  readonly failure: ToolFailure;
  readonly ruleIds: readonly RuleId[];
  readonly detail?: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResponse(value: unknown): value is ToolResponse {
  if (!isRecord(value)) return false;
  return value["ok"] === true || (value["ok"] === false && ToolFailureSchema.safeParse(value).success);
}

function withoutPrincipal(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !(PRINCIPAL_KEYS as readonly string[]).includes(key)));
}

/**
 * Paths of the issues only: the values the model wrote never go back to it, to the log or to the audit.
 * An undeclared key is the model's own text, so it is clipped and redacted like a log line.
 */
function issuePaths(error: z.ZodError): string[] {
  const paths = error.issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys.map((key) => [...issue.path, key].join(".")) : [issue.path.join(".") || "(input)"]));
  return [...new Set(paths.map((path) => redactText(path.slice(0, MAX_PATH))))].slice(0, MAX_PATHS);
}

function assertTargetShape(target: ToolTarget, tools: Readonly<Record<string, ToolDefinition>>, implementations: Readonly<Record<string, unknown>>): void {
  const expected = [...GATEWAY_TOOLS[target]].sort().join(",");
  const declared = Object.keys(tools).sort().join(",");
  const implemented = Object.keys(implementations).sort().join(",");
  if (declared !== expected || implemented !== expected) throw new Error(`target ${target} must declare and implement exactly ${expected}`);
  for (const [name, definition] of Object.entries(tools)) if (definition.name !== name) throw new Error(`target ${target}: ${name} holds the definition of ${definition.name}`);
}

export function createToolHandler<T extends ToolTarget, Tools extends TargetTools<T>>(spec: TargetSpec<T, Tools>, deps: ToolDeps): GatewayTargetRuntime {
  const tools: Readonly<Record<string, ToolDefinition>> = spec.tools;
  const implementations = spec.implementations as unknown as Readonly<Record<string, (ctx: ToolContext<unknown>) => Promise<ToolResponse>>>;
  assertTargetShape(spec.target, tools, implementations);
  const lookups = connectorLookups(deps.connector);

  function logFor(correlationId: string, tool: string, principal?: ToolPrincipal): Logger {
    return deps.loggerFor(correlationId).child({ service: "agent-tools", target: spec.target, tool, ...(principal === undefined ? {} : { principal: principal.kind }) });
  }

  async function refuse(resolved: Resolved, tool: GatewayToolName, refusal: Refusal, audit: Partial<AuditEntry> = {}): Promise<ToolFailure> {
    try {
      await auditorOf({ connector: deps.connector, tool, scope: resolved.scope, principal: resolved.principal, wallClock: deps.wallClock, correlationId: resolved.correlationId })({
        decision: "DENY",
        ruleIds: refusal.ruleIds,
        ...(refusal.failure.error.reason === undefined ? {} : { reason: refusal.failure.error.reason }),
        ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
        ...audit,
      });
    } catch (error) {
      resolved.log.error("tool.audit_failed", { error });
    }
    resolved.log.warn("tool.denied", { rule: refusal.ruleIds[0], code: refusal.failure.error.code, reason: refusal.failure.error.reason });
    return refusal.failure;
  }

  async function resolveSessionCall(tool: GatewayToolName, token: unknown, callerRefusal: string | undefined, origin: Origin): Promise<Resolved | ToolFailure> {
    const resolution = await resolveToolSession(deps.sessionKey(), token, deps.connector, deps.wallClock().getTime());
    if (!resolution.ok) {
      const failure = toToolFailure(resolution.error);
      const closed = resolution.closedSession;
      if (closed === undefined) {
        logFor(correlationIdFrom(origin.requestId), tool).warn("tool.session_refused", { code: failure.error.code, reason: failure.error.reason });
        return failure;
      }
      const principal: ToolPrincipal = { kind: "SESSION", sessionId: closed.sessionId, turnId: closed.turnId, trigger: closed.trigger };
      const correlationId = correlationIdFrom(closed.turnId);
      const resolved = { scope: toolScope(closed, closed.eventAtSim), principal, correlationId, log: logFor(correlationId, tool, principal) };
      return refuse(resolved, tool, { failure, ruleIds: [], detail: { turnClosed: true } }, { reason: FENCE_REASON.TURN_CLOSED });
    }
    const { session } = resolution;
    const principal: ToolPrincipal = { kind: "SESSION", sessionId: session.sessionId, turnId: session.turnId, trigger: session.trigger, ...(resolution.eventId === undefined ? {} : { eventId: resolution.eventId }) };
    const correlationId = correlationIdFrom(resolution.eventId ?? session.turnId);
    const resolved: Resolved = { scope: toolScope(session, session.eventAtSim), principal, correlationId, log: logFor(correlationId, tool, principal) };
    if (callerRefusal === undefined) return resolved;
    return refuse(resolved, tool, { failure: fail("FORBIDDEN", "a caller is never accepted next to a sessionToken", callerRefusal), ruleIds: ["LAM-CALLER"] });
  }

  /**
   * A caller naming another firm's operation: recorded in the caller's own firm and never on that
   * operation's trail, so the other firm sees nothing of who asked (as the console fence does).
   */
  async function refuseCrossFirm(tool: GatewayToolName, firmId: string, operationId: string, principal: ToolPrincipal, correlationId: string, log: Logger): Promise<ToolFailure> {
    const failure = fail("FORBIDDEN", "the operation belongs to another firm", FENCE_REASON.CROSS_FIRM);
    try {
      await deps.connector.audit.record({
        firmId,
        decision: "DENY",
        action: toolAction(tool),
        ruleIds: ["LAM-OP-SCOPE"],
        actor: actorOf(principal),
        refs: principal.kind !== "SESSION" && principal.caller.brokerId !== undefined ? { brokerId: principal.caller.brokerId } : {},
        reason: FENCE_REASON.CROSS_FIRM,
        atReal: deps.wallClock().toISOString(),
        correlationId,
        detail: { targetKind: "operation", targetId: operationId },
      });
    } catch (error) {
      log.error("tool.audit_failed", { error });
    }
    log.warn("tool.denied", { rule: "LAM-OP-SCOPE", code: failure.error.code, reason: failure.error.reason });
    return failure;
  }

  async function resolveCallerCall(definition: ToolDefinition, claim: Extract<PrincipalClaim, { kind: "CALLER" }>): Promise<Resolved | ToolFailure> {
    const { caller } = claim;
    const tool = definition.name;
    const operation = await deps.connector.operations.findOperation(claim.operationId);
    if (operation === undefined) return fail("NOT_FOUND", "operation not found");
    const principal: ToolPrincipal = { kind: caller.kind, caller };
    const correlationId = correlationIdFrom(caller.eventId);
    const log = logFor(correlationId, tool, principal);
    if (caller.firmId !== undefined && caller.firmId !== operation.firmId) return refuseCrossFirm(tool, caller.firmId, claim.operationId, principal, correlationId, log);
    const clock = worldClock(operation.clockId, { readClock: (clockId) => deps.connector.world.findClock(clockId), realClock: { now: async () => deps.wallClock() } });
    const resolved: Resolved = { scope: toolScope(operation, (await clock.now()).toISOString()), principal, correlationId, log };
    if (definition.callers.includes(caller.kind)) return resolved;
    return refuse(resolved, tool, { failure: fail("FORBIDDEN", `a ${caller.kind} caller may not call ${tool}`, PRINCIPAL_REASON.ROLE_NOT_ALLOWED), ruleIds: ["LAM-CALLER"] });
  }

  /** Steps 4 and 5: strict input, then the trigger (no read needed), then the operation scope. */
  async function fence(definition: ToolDefinition, raw: Readonly<Record<string, unknown>>, resolved: Resolved): Promise<{ readonly ok: true; readonly input: Record<string, unknown> } | ToolFailure> {
    const tool = definition.name;
    const schema = resolved.principal.kind === "SESSION" ? definition.gatewayInput : definition.directInput;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const denied = definition.deniedFields.filter((field) => raw[field] !== undefined);
      const rules = denied.map((field) => deniedFieldOf(definition.fields[field] ?? {})?.ruleId).filter((rule) => rule !== undefined);
      const fields = issuePaths(parsed.error);
      const message = denied.length > 0 ? `${denied.join(", ")} is never accepted (${rules.join(", ")})` : `invalid input: ${fields.join(", ")}`;
      return refuse(resolved, tool, { failure: fail("INVALID", message, FENCE_REASON.VALIDATION), ruleIds: ["LAM-STRICT"], detail: { fields, deniedFields: denied } });
    }
    const input = withoutPrincipal(parsed.data);
    if (resolved.principal.kind === "SESSION") {
      const allowed = definition.triggers?.(input as never);
      const trigger = resolved.principal.trigger;
      if (allowed !== undefined && !allowed.includes(trigger)) {
        const failure = fail("FORBIDDEN", `not allowed in a ${trigger} turn (only ${allowed.join(" or ")}); leave it in the turn note`, FENCE_REASON.TRIGGER_NOT_ALLOWED);
        return refuse(resolved, tool, { failure, ruleIds: ["LAM-TRIGGER"], detail: { trigger, allowed: [...allowed] } });
      }
    }
    const violation = await scopeViolation(resolved.scope, input, lookups);
    if (violation?.reason === "INPUT_TOO_LARGE") {
      return refuse(resolved, tool, { failure: fail("FORBIDDEN", "the input names too many ids", FENCE_REASON.INPUT_TOO_LARGE), ruleIds: ["LAM-OP-SCOPE"], detail: { limit: violation.limit } });
    }
    if (violation !== undefined) {
      const { ref, why } = violation;
      const failure = fail("FORBIDDEN", `${ref.path} ${why}`, FENCE_REASON.OUT_OF_SCOPE);
      return refuse(resolved, tool, { failure, ruleIds: ["LAM-OP-SCOPE"], detail: { path: ref.path, kind: ref.kind, targetId: ref.value } });
    }
    return { ok: true, input };
  }

  async function run(definition: ToolDefinition, input: Record<string, unknown>, resolved: Resolved): Promise<ToolResponse> {
    const tool = definition.name;
    const implementation = implementations[tool];
    const ctx: ToolContext<unknown> = {
      target: spec.target,
      tool,
      input,
      scope: resolved.scope,
      principal: resolved.principal,
      connector: deps.connector,
      wallClock: deps.wallClock,
      correlationId: resolved.correlationId,
      log: resolved.log,
      audit: auditorOf({ connector: deps.connector, tool, scope: resolved.scope, principal: resolved.principal, wallClock: deps.wallClock, correlationId: resolved.correlationId }),
    };
    let result: ToolResponse;
    try {
      const answer: unknown = implementation === undefined ? fail("UNAVAILABLE", "tool not available") : await implementation(ctx);
      result = isToolResponse(answer) ? answer : fail("UNAVAILABLE", "temporary failure, try again later");
    } catch (error) {
      result = toToolFailure(error);
      if (!(error instanceof ToolError)) resolved.log.error("tool.failed", { error });
    }
    const { principal } = resolved;
    if (principal.kind === "SESSION" && result.ok) {
      try {
        await deps.connector.runtime.appendTurnResult({ turnId: principal.turnId, tool, output: { ...result }, atReal: deps.wallClock().toISOString() });
      } catch (error) {
        // Without its TURN# row the result cannot ground a message: a later send fails closed (GROUNDING_FAIL).
        resolved.log.error("tool.turn_result_failed", { error });
      }
    }
    return result;
  }

  async function call(toolName: string, raw: unknown, origin: Origin): Promise<ToolResponse> {
    const started = deps.wallClock().getTime();
    const definition = tools[toolName];
    if (definition === undefined) return fail("INVALID", `unknown tool of the ${spec.target} target`);
    if (!isRecord(raw)) return fail("INVALID", "the input must be an object");
    const claim = claimOf(raw, origin.fromGateway);
    if (claim.kind === "REFUSED") {
      logFor(correlationIdFrom(origin.requestId), definition.name).warn("tool.principal_refused", { code: claim.error.code, reason: claim.error.reason });
      return claim.error.toFailure();
    }
    const resolved = claim.kind === "SESSION" ? await resolveSessionCall(definition.name, claim.token, claim.callerRefusal, origin) : await resolveCallerCall(definition, claim);
    if ("ok" in resolved) return resolved;
    const fenced = await fence(definition, raw, resolved);
    if (!fenced.ok) return fenced;
    const result = await run(definition, fenced.input, resolved);
    resolved.log.info("tool.call", { ok: result.ok, code: result.ok ? undefined : result.error.code, durationMs: deps.wallClock().getTime() - started });
    return result;
  }

  async function safely(work: () => Promise<ToolResponse>): Promise<ToolResponse> {
    try {
      return await work();
    } catch (error) {
      return toToolFailure(error);
    }
  }

  return {
    target: spec.target,
    handle: (event, context) =>
      safely(async () => {
        const marks = gatewayMarksOf(context);
        if (marks.present) {
          const name = marks.toolName ?? "";
          const separator = name.indexOf(GATEWAY_TOOL_SEPARATOR);
          if (separator < 0 || name.slice(0, separator) !== spec.target) return fail("FORBIDDEN", `the Gateway named a tool outside the ${spec.target} target`);
          return call(name.slice(separator + GATEWAY_TOOL_SEPARATOR.length), event, { fromGateway: true, requestId: marks.requestId ?? context?.awsRequestId });
        }
        const direct = DirectLambdaEvent.safeParse(event);
        if (!direct.success) return fail("INVALID", "expected a Gateway call or {tool, input}");
        return call(direct.data.tool, direct.data.input, { fromGateway: false, requestId: context?.awsRequestId });
      }),
    invoke: (tool, input) => safely(() => call(tool, input, { fromGateway: false })),
  };
}

