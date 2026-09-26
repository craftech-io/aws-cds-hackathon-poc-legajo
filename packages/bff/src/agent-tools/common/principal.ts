// Who a tool call acts for (docs/tool-catalog.md "Sesión" and "Invocación directa", `LAM-CALLER` of
// docs/design-brief.md §5.6).
//
// Through the Gateway the only principal is the Harness, and it proves nothing by itself: the call carries
// the `sessionToken` the worker signed for the turn, and everything (operation, firm, parties, clock,
// trigger) is read from `Runtime/SESSION#<sessionId>`. A token of a closed turn is refused.
//
// Outside the Gateway, deterministic code calls in process with a `caller` and the operation. `caller`
// does not authenticate (a Lambda cannot see the role that invoked it): the fence is who can reach the
// code at all, plus the XOR here. `caller` is refused when the input also brings a `sessionToken`, and
// when the invocation context carries the Gateway's marks (AgentCore puts them in the Lambda client
// context of every Gateway call), so the model can never pose as the worker or the console.
import { z } from "zod";
import { Caller, type CallerKind, ERROR_REASON, OperationId, ToolError, type TurnTrigger } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import type { Session } from "../../domain/runtime";
import type { SecretKey } from "../../lib/crypto";
import { type ResolvedSession, type SessionStore, resolveSession } from "../../services/session";

/** Keys AgentCore Gateway puts in `context.clientContext.custom` of a Lambda target invocation. */
export const GATEWAY_CONTEXT_KEYS = [
  "bedrockAgentCoreMessageVersion",
  "bedrockAgentCoreAwsRequestId",
  "bedrockAgentCoreMcpMessageId",
  "bedrockAgentCoreGatewayId",
  "bedrockAgentCoreTargetId",
  "bedrockAgentCoreToolName",
] as const;

/** Separator of `<target>___<tool>`, the name the Gateway (and Cedar) give a tool. */
export const GATEWAY_TOOL_SEPARATOR = "___";

/** What a target reads from the Lambda context; the Node runtime gives the client context as sent. */
export interface LambdaContextLike {
  readonly awsRequestId?: string;
  readonly clientContext?: unknown;
}

export interface GatewayMarks {
  /** True when any AgentCore key is present: the call came through the Gateway. */
  readonly present: boolean;
  /** `<target>___<tool>`. */
  readonly toolName?: string;
  readonly requestId?: string;
}

function customOf(clientContext: unknown): Record<string, unknown> | undefined {
  if (typeof clientContext !== "object" || clientContext === null) return undefined;
  // The Node runtime passes the client context as the invoker wrote it; accept either casing of `custom`.
  const custom = Reflect.get(clientContext, "custom") ?? Reflect.get(clientContext, "Custom");
  return typeof custom === "object" && custom !== null ? (custom as Record<string, unknown>) : undefined;
}

export function gatewayMarksOf(context: LambdaContextLike | undefined): GatewayMarks {
  const custom = customOf(context?.clientContext);
  if (custom === undefined) return { present: false };
  const present = GATEWAY_CONTEXT_KEYS.some((key) => key in custom);
  const toolName = custom["bedrockAgentCoreToolName"];
  const requestId = custom["bedrockAgentCoreAwsRequestId"];
  return {
    present,
    ...(typeof toolName === "string" ? { toolName } : {}),
    ...(typeof requestId === "string" ? { requestId } : {}),
  };
}

/**
 * The context the Gateway gives a target for the action `<target>___<tool>`: what the local flows'
 * Gateway (tests/flows/support/gateway.ts) passes after Cedar allowed the call, and what tests use.
 */
export function gatewayContext(action: string, ids: { readonly requestId?: string; readonly gatewayId?: string } = {}): LambdaContextLike {
  const requestId = ids.requestId ?? "local-gateway-request";
  return {
    awsRequestId: requestId,
    clientContext: {
      custom: {
        bedrockAgentCoreMessageVersion: "1.0",
        bedrockAgentCoreAwsRequestId: requestId,
        bedrockAgentCoreMcpMessageId: requestId,
        bedrockAgentCoreGatewayId: ids.gatewayId ?? "local-gateway",
        bedrockAgentCoreTargetId: action.split(GATEWAY_TOOL_SEPARATOR)[0] ?? "",
        bedrockAgentCoreToolName: action,
      },
    },
  };
}

/** Who the implementation acts for; the audit actor and the TURN# write depend on it. */
export type ToolPrincipal =
  | { readonly kind: "SESSION"; readonly sessionId: string; readonly turnId: string; readonly trigger: TurnTrigger; readonly eventId?: string }
  | { readonly kind: CallerKind; readonly caller: Caller };

/** Why a principal was refused, as the tool error's `reason` says it. */
export const PRINCIPAL_REASON = {
  CALLER_WITH_TOKEN: "CALLER_WITH_TOKEN",
  CALLER_FROM_GATEWAY: "CALLER_FROM_GATEWAY",
  NO_PRINCIPAL: "NO_PRINCIPAL",
  CALLER_INVALID: "CALLER_INVALID",
  ROLE_NOT_ALLOWED: ERROR_REASON.ROLE_NOT_ALLOWED,
} as const;

export type PrincipalClaim =
  | { readonly kind: "SESSION"; readonly token: unknown; readonly callerRefusal?: string }
  | { readonly kind: "CALLER"; readonly caller: Caller; readonly operationId: string }
  | { readonly kind: "REFUSED"; readonly error: ToolError };

const DirectPrincipal = z.object({ caller: Caller, operationId: OperationId });

/**
 * `sessionToken` XOR `caller` (`LAM-CALLER`). A refused `caller` that came with a token is still resolved
 * through the token, so the refusal can be audited in the firm of an authentic session.
 */
export function claimOf(input: Readonly<Record<string, unknown>>, fromGateway: boolean): PrincipalClaim {
  const hasToken = input["sessionToken"] !== undefined;
  const hasCaller = input["caller"] !== undefined;
  if (hasCaller && (hasToken || fromGateway)) {
    const reason = hasToken ? PRINCIPAL_REASON.CALLER_WITH_TOKEN : PRINCIPAL_REASON.CALLER_FROM_GATEWAY;
    if (hasToken) return { kind: "SESSION", token: input["sessionToken"], callerRefusal: reason };
    return { kind: "REFUSED", error: new ToolError("FORBIDDEN", "a caller is never accepted from the Gateway", reason) };
  }
  if (hasToken) return { kind: "SESSION", token: input["sessionToken"] };
  if (fromGateway) return { kind: "REFUSED", error: new ToolError("FORBIDDEN", "every Gateway call needs the sessionToken of the turn", ERROR_REASON.SESSION_INVALID) };
  if (!hasCaller) return { kind: "REFUSED", error: new ToolError("FORBIDDEN", "the call names neither a session nor a caller", PRINCIPAL_REASON.NO_PRINCIPAL) };
  const direct = DirectPrincipal.safeParse(input);
  if (!direct.success) return { kind: "REFUSED", error: new ToolError("INVALID", "invalid caller or operation", PRINCIPAL_REASON.CALLER_INVALID) };
  return { kind: "CALLER", caller: direct.data.caller, operationId: direct.data.operationId };
}

export type SessionResolution =
  | { readonly ok: true; readonly session: ResolvedSession; readonly eventId?: string }
  | { readonly ok: false; readonly error: unknown; readonly closedSession?: ResolvedSession };

/**
 * Resolves a token with services/session.ts. When it is refused only because its turn already closed,
 * the stored session is returned too: the token was authentic (the store is read only after the
 * signature and expiry verified), so the refusal can be audited in that session's firm. Forged or
 * expired tokens name no one and leave only a log line.
 */
export async function resolveToolSession(sessionKey: SecretKey, token: unknown, connector: Connector, nowMs: number): Promise<SessionResolution> {
  let loaded: Session | undefined;
  const store: SessionStore = {
    getSession: async (sessionId) => {
      loaded = await connector.runtime.getSession(sessionId);
      return loaded;
    },
    getTurn: (turnId) => connector.runtime.getTurn(turnId),
  };
  try {
    const session = await resolveSession(sessionKey, token, store, nowMs);
    return { ok: true, session, ...(loaded?.eventId === undefined ? {} : { eventId: loaded.eventId }) };
  } catch (error) {
    const closed = error instanceof ToolError && error.reason === ERROR_REASON.SESSION_EXPIRED && loaded !== undefined;
    if (!closed || loaded === undefined) return { ok: false, error };
    const { sessionId, turnId, operationId, firmId, importerId, supplierId, trigger, clockId, eventAtSim } = loaded;
    return { ok: false, error, closedSession: { sessionId, turnId, operationId, firmId, importerId, supplierId, trigger, clockId, eventAtSim, exp: 0 } };
  }
}
