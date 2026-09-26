// What an implementation receives from `createToolHandler` (handler.ts): its parsed input, the scope of
// the operation, the principal, the connector, the clocks, a logger bound to the call and an audit
// writer that fills in the firm, the world, the actor and the references of the call. Every tool with
// an effect records its decision through `audit` (docs/tool-catalog.md "Bitácora"), and the wrapper
// records its own refusals the same way.
import type { AuditDecision, GatewayToolName, MessageId, RuleId, ToolFailure, ToolOk, ToolTarget } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import type { Decision, DecisionRefs, EvaluatedRule } from "../../domain/audit";
import { type Actor, brokerActor } from "../../domain/common";
import type { Logger } from "../../lib/log";
import type { ToolDefinition, ToolInput } from "./define";
import type { ToolPrincipal } from "./principal";
import type { ToolScope } from "./scope";

/** What a tool answers: never thrown, always this envelope (docs/tool-catalog.md "Errores"). */
export type ToolResponse = ToolOk<Record<string, unknown>> | ToolFailure;

export interface AuditEntry {
  readonly decision: AuditDecision;
  /** UPPER_SNAKE_CASE; the tool's own name (`SEND_WHATSAPP`) unless the effect has a name of its own. */
  readonly action?: string;
  readonly ruleIds?: readonly RuleId[];
  readonly evaluated?: readonly EvaluatedRule[];
  readonly reason?: string;
  readonly messageId?: MessageId;
  readonly refs?: DecisionRefs;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ToolContext<I> {
  readonly target: ToolTarget;
  readonly tool: GatewayToolName;
  readonly input: I;
  readonly scope: ToolScope;
  readonly principal: ToolPrincipal;
  readonly connector: Connector;
  /** Real time (link expiry, `atReal` stamps); business rules use `scope.nowSim`. */
  readonly wallClock: () => Date;
  readonly correlationId: string;
  readonly log: Logger;
  audit(entry: AuditEntry): Promise<Decision>;
}

export type ToolImplementation<I> = (ctx: ToolContext<I>) => Promise<ToolResponse>;

/** One implementation per tool of a target, typed by its definition. */
export type Implementations<Tools extends Readonly<Record<string, ToolDefinition>>> = {
  readonly [K in keyof Tools]: ToolImplementation<ToolInput<Tools[K]>>;
};

/** `get_dossier` → `GET_DOSSIER`, the action of an audit row about the tool. */
export function toolAction(tool: GatewayToolName): string {
  return tool.toUpperCase();
}

/** The agent for a session; the deterministic code for internal callers; the broker or QA for the console. */
export function actorOf(principal: ToolPrincipal): Actor {
  if (principal.kind === "SESSION") return "AGENT";
  if (principal.kind === "QA") return "QA";
  if (principal.kind === "CONSOLE" && principal.caller.brokerId !== undefined) return brokerActor(principal.caller.brokerId);
  return "SYSTEM";
}

export interface AuditorInput {
  readonly connector: Connector;
  readonly tool: GatewayToolName;
  readonly scope: ToolScope;
  readonly principal: ToolPrincipal;
  readonly wallClock: () => Date;
  readonly correlationId: string;
}

/** The `audit` of a call: firm, world, operation, actor, trigger and the turn's references filled in. */
export function auditorOf(input: AuditorInput): (entry: AuditEntry) => Promise<Decision> {
  const { principal, scope } = input;
  const baseRefs: DecisionRefs = {
    operationId: scope.operationId,
    ...(principal.kind === "SESSION" ? { turnId: principal.turnId, ...(principal.eventId === undefined ? {} : { eventId: principal.eventId }) } : {}),
    ...(principal.kind !== "SESSION" && principal.caller.eventId !== undefined ? { eventId: principal.caller.eventId } : {}),
    ...(principal.kind !== "SESSION" && principal.caller.brokerId !== undefined ? { brokerId: principal.caller.brokerId } : {}),
  };
  return (entry) =>
    input.connector.audit.record({
      firmId: scope.firmId,
      decision: entry.decision,
      action: entry.action ?? toolAction(input.tool),
      ruleIds: [...(entry.ruleIds ?? [])],
      evaluated: (entry.evaluated ?? []).map((rule) => ({ ...rule })),
      actor: actorOf(principal),
      refs: { ...baseRefs, ...(entry.refs ?? {}) },
      clockId: scope.clockId,
      operationId: scope.operationId,
      atSim: scope.nowSim,
      atReal: input.wallClock().toISOString(),
      correlationId: input.correlationId,
      ...(principal.kind === "SESSION" ? { trigger: principal.trigger } : {}),
      ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.detail === undefined ? {} : { detail: { ...entry.detail } }),
    });
}
