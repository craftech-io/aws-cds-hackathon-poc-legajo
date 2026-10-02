// The direct-invocation handlers of docs/tool-catalog.md ("Handlers de invocación directa"): the
// deterministic handlers the console, the `QaDriver`, the worker, the channel entries and the scheduler
// call in process, never through the Gateway. Every call goes through `createDirectHandler`, which, in
// order:
//
//   1. refuses a `sessionToken` next to a `caller` (`LAM-CALLER`): a token is the model's, and these
//      handlers are never the model's;
//   2. parses `caller` (`Caller` of @legajo/shared) and admits only the kinds the catalog lists for the
//      handler; a `QA` caller acts only inside a QA firm (ADR-0005);
//   3. admits only the console roles the handler allows (approve and reopen: `BROKER` or `GUEST`), else
//      403 and `AuditLog DENY ROLE_NOT_ALLOWED` in the caller's firm (FL-075);
//   4. parses the rest of the input strict (`LAM-STRICT`): an undeclared key or a value out of its enum
//      is `INVALID`, reported by path only;
//   5. runs the implementation, which fences every record it reaches to the caller's firm
//      (`ctx.fence`: 403 and `AuditLog DENY CROSS_FIRM`, the attempted id only in `detail`, FL-082).
//
// Nothing here throws: the answer is `{ok: true, …}` or `{ok: false, error}`; a guest world's spent
// quota also carries `quota {kind, resetsAtReal}` so the console can say when it renews (ADR-0015 §4).
import { z } from "zod";
import { type AuditDecision, Caller, type CallerKind, type ConsoleRole, QA_FIRM_IDS, type RuleId, ToolError, type ToolFailure, type ToolOk, ok, toToolFailure } from "@legajo/shared";
import { QuotaExceededError } from "@legajo/shared/errors";
import type { QuotaExceededKind } from "@legajo/shared/guest-limits";
import type { FencedId } from "../../auth/scope";
import type { Connector } from "../../connector/connector";
import type { Decision, DecisionRefs, EvaluatedRule } from "../../domain/audit";
import { type Actor, brokerActor } from "../../domain/common";
import type { Clock } from "../../domain/world-state";
import { simNowOf } from "../../lib/clock";
import { type Logger, correlationIdFrom, redactText } from "../../lib/log";

/** The handlers of the catalog this kit runs (docs/tool-catalog.md, WP-43). */
export const DIRECT_HANDLERS = [
  "verify_sender",
  "record_consent",
  "revoke_consent",
  "authorize_supplier_contact",
  "confirm_supplier_contact",
  "upsert_party",
  "create_operation",
  "approve_dossier",
  "reopen_dossier",
  "waive_observation",
  "classify_unrecognized",
  "take_conversation",
  "release_conversation",
  "broker_send",
  "apply_email_event",
  "deferred_send",
  "record_activity",
] as const;
export type DirectHandlerName = (typeof DIRECT_HANDLERS)[number];

/** `reason` of the kit's own refusals (the console switches on it). */
export const HANDLER_REASON = {
  CALLER_WITH_TOKEN: "CALLER_WITH_TOKEN",
  CALLER_INVALID: "CALLER_INVALID",
  CALLER_NOT_ALLOWED: "CALLER_NOT_ALLOWED",
  QA_FIRM_ONLY: "QA_FIRM_ONLY",
  NO_BROKER: "NO_BROKER",
  VALIDATION: "VALIDATION",
  ROLE_NOT_ALLOWED: "ROLE_NOT_ALLOWED",
  CROSS_FIRM: "CROSS_FIRM",
} as const;

/** `LAM-CALLER` is the rule of every refusal of who is calling. */
const CALLER_RULE: RuleId = "LAM-CALLER";

const MAX_PATH = 64;
const MAX_PATHS = 10;

export interface KitDeps {
  readonly connector: Connector;
  /** Real time: audit stamps, quotas, and the real side of a world clock (ADR-0007). */
  readonly wallClock: () => Date;
  readonly loggerFor: (correlationId: string) => Logger;
}

/** What an implementation records; the kit fills the actor, the stamps and the caller's references. */
export interface AuditInput {
  readonly firmId: string;
  readonly decision: AuditDecision;
  /** UPPER_SNAKE_CASE (`CONSENT_GRANTED`, `APPROVED`, `TAKEOVER`). */
  readonly action: string;
  readonly clockId?: string;
  readonly operationId?: string;
  readonly atSim?: string;
  readonly ruleIds?: readonly RuleId[];
  readonly evaluated?: readonly EvaluatedRule[];
  readonly reason?: string;
  readonly messageId?: string;
  readonly trigger?: string;
  readonly refs?: DecisionRefs;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** A world's clock read at the call's real instant: the simulated "now" of every business date. */
export interface WorldNow {
  readonly clock: Clock;
  readonly simNow: Date;
  readonly atSim: string;
}

export interface DirectContext<I> {
  readonly handler: DirectHandlerName;
  readonly input: I;
  readonly caller: Caller;
  /** The broker for the console, `QA` for the `QaDriver`, the deterministic code for everyone else. */
  readonly actor: Actor;
  readonly correlationId: string;
  readonly log: Logger;
  readonly connector: Connector;
  /** Real time of the call. */
  readonly now: () => Date;
  audit(entry: AuditInput): Promise<Decision>;
  /** 403 and `AuditLog DENY CROSS_FIRM` unless `ownerFirmId` is the caller's firm (no-op for a caller without one). */
  fence(ownerFirmId: string, target: FencedId): Promise<void>;
  world(clockId: string): Promise<WorldNow>;
}

export interface QuotaFailure {
  readonly kind: QuotaExceededKind;
  readonly resetsAtReal: string;
}

export type DirectFailure = ToolFailure & { readonly quota?: QuotaFailure };
export type DirectResponse<R extends object = Record<string, unknown>> = ToolOk<R> | DirectFailure;
export type DirectHandler<R extends object = Record<string, unknown>> = (raw: unknown, options?: { readonly correlationId?: string }) => Promise<DirectResponse<R>>;

export interface DirectSpec<S extends z.ZodType, R extends object> {
  readonly name: DirectHandlerName;
  /** The handler's own fields (everything but `caller`), strict. */
  readonly input: S;
  /** Caller kinds docs/tool-catalog.md lists for the handler. */
  readonly callers: readonly CallerKind[];
  /** Console roles allowed to a `CONSOLE` or `QA` caller; every role when absent. */
  readonly roles?: readonly ConsoleRole[];
  run(ctx: DirectContext<z.output<S>>): Promise<R>;
}

/** Callers that act for a firm the server put in the principal (docs/tool-catalog.md, "Invocación directa"). */
const FIRM_BOUND: ReadonlySet<CallerKind> = new Set<CallerKind>(["CONSOLE", "QA"]);

export function actorOfCaller(caller: Caller): Actor {
  if (caller.kind === "QA") return "QA";
  if (caller.kind === "CONSOLE" && caller.brokerId !== undefined) return brokerActor(caller.brokerId);
  return "SYSTEM";
}

/** The broker a console or QA action is signed by (`approvedBy`, `author BROKER:<id>`). */
export function actingBroker(caller: Caller): string {
  if (caller.brokerId === undefined) throw new ToolError("FORBIDDEN", "this action names the broker who takes it", HANDLER_REASON.NO_BROKER);
  return caller.brokerId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issuePaths(error: z.ZodError): string[] {
  const paths = error.issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys.map((key) => [...issue.path, key].join(".")) : [issue.path.join(".") || "(input)"]));
  return [...new Set(paths.map((path) => redactText(path.slice(0, MAX_PATH))))].slice(0, MAX_PATHS);
}

/** The envelope of anything a handler threw; a spent quota keeps its kind and renewal. */
export function failureOf(error: unknown): DirectFailure {
  const failure = toToolFailure(error);
  return error instanceof QuotaExceededError ? { ...failure, quota: { kind: error.kind, resetsAtReal: error.resetsAtReal } } : failure;
}

/**
 * For the routers and the worker: the payload of a successful call, or the handler's own refusal thrown
 * again (`QuotaExceededError` for a spent quota, so trpc.ts answers `TOO_MANY_REQUESTS` with its renewal).
 */
export function unwrapDirect<R extends object>(response: DirectResponse<R>): ToolOk<R> {
  if (response.ok) return response;
  if (response.quota !== undefined) throw new QuotaExceededError(response.quota.kind, response.quota.resetsAtReal);
  throw new ToolError(response.error.code, response.error.message, response.error.reason);
}

interface Admitted {
  readonly caller: Caller;
  readonly fields: Record<string, unknown>;
}

export function createDirectHandler<S extends z.ZodType, R extends object>(spec: DirectSpec<S, R>, deps: KitDeps): DirectHandler<R> {
  const { connector } = deps;

  async function deny(caller: Caller, log: Logger, correlationId: string, refusal: "ROLE_NOT_ALLOWED" | "CROSS_FIRM", message: string, target?: FencedId): Promise<void> {
    if (caller.firmId === undefined) return;
    try {
      await connector.audit.record({
        firmId: caller.firmId,
        decision: "DENY",
        action: refusal,
        ruleIds: refusal === "ROLE_NOT_ALLOWED" ? [CALLER_RULE] : [],
        actor: actorOfCaller(caller),
        refs: caller.brokerId === undefined ? {} : { brokerId: caller.brokerId },
        reason: message,
        atReal: deps.wallClock().toISOString(),
        correlationId,
        detail: { handler: spec.name, callerKind: caller.kind, ...(caller.role === undefined ? {} : { role: caller.role }), ...(target === undefined ? {} : { targetKind: target.kind, targetId: target.id }) },
      });
    } catch (error) {
      // The refusal stands even when its trace could not be written.
      log.error("refusal not audited", { handler: spec.name, refusal, error: error instanceof Error ? error.name : "unknown" });
    }
  }

  async function admit(raw: unknown, log: Logger, correlationId: string): Promise<Admitted> {
    if (!isRecord(raw)) throw new ToolError("INVALID", "the input must be an object", HANDLER_REASON.VALIDATION);
    if (raw["sessionToken"] !== undefined) throw new ToolError("FORBIDDEN", "a session token is never a direct caller's", HANDLER_REASON.CALLER_WITH_TOKEN);
    const parsed = Caller.safeParse(raw["caller"]);
    if (!parsed.success) throw new ToolError("INVALID", "invalid caller", HANDLER_REASON.CALLER_INVALID);
    const caller = parsed.data;
    if (!spec.callers.includes(caller.kind)) throw new ToolError("FORBIDDEN", `${spec.name} is not for a ${caller.kind} caller`, HANDLER_REASON.CALLER_NOT_ALLOWED);
    if (caller.kind === "QA" && (caller.firmId === undefined || !QA_FIRM_IDS.includes(caller.firmId))) {
      throw new ToolError("FORBIDDEN", "QA acts only inside a QA firm", HANDLER_REASON.QA_FIRM_ONLY);
    }
    if (FIRM_BOUND.has(caller.kind) && spec.roles !== undefined && (caller.role === undefined || !spec.roles.includes(caller.role))) {
      const message = `${spec.name} needs one of the roles ${spec.roles.join(", ")}`;
      await deny(caller, log, correlationId, "ROLE_NOT_ALLOWED", message);
      throw new ToolError("FORBIDDEN", message, HANDLER_REASON.ROLE_NOT_ALLOWED);
    }
    const { caller: _caller, ...fields } = raw;
    return { caller, fields };
  }

  function contextOf(caller: Caller, input: z.output<S>, log: Logger, correlationId: string): DirectContext<z.output<S>> {
    const actor = actorOfCaller(caller);
    const callerRefs: DecisionRefs = {
      ...(caller.brokerId === undefined ? {} : { brokerId: caller.brokerId }),
      ...(caller.eventId === undefined ? {} : { eventId: caller.eventId }),
    };
    return {
      handler: spec.name,
      input,
      caller,
      actor,
      correlationId,
      log,
      connector,
      now: deps.wallClock,
      audit: (entry) =>
        connector.audit.record({
          firmId: entry.firmId,
          decision: entry.decision,
          action: entry.action,
          ruleIds: [...(entry.ruleIds ?? [])],
          evaluated: (entry.evaluated ?? []).map((rule) => ({ ...rule })),
          actor,
          refs: { ...callerRefs, ...(entry.operationId === undefined ? {} : { operationId: entry.operationId }), ...(entry.refs ?? {}) },
          atReal: deps.wallClock().toISOString(),
          correlationId,
          ...(entry.clockId === undefined ? {} : { clockId: entry.clockId }),
          ...(entry.operationId === undefined ? {} : { operationId: entry.operationId }),
          ...(entry.atSim === undefined ? {} : { atSim: entry.atSim }),
          ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
          ...(entry.trigger === undefined ? {} : { trigger: entry.trigger }),
          ...(entry.reason === undefined ? {} : { reason: entry.reason }),
          ...(entry.detail === undefined ? {} : { detail: { ...entry.detail } }),
        }),
      fence: async (ownerFirmId, target) => {
        if (caller.firmId === undefined || caller.firmId === ownerFirmId) return;
        const message = `${target.kind} ${target.id} is not of the caller's firm`;
        await deny(caller, log, correlationId, "CROSS_FIRM", message, target);
        throw new ToolError("FORBIDDEN", message, HANDLER_REASON.CROSS_FIRM);
      },
      world: async (clockId) => {
        const clock = await connector.world.getClock(clockId);
        const simNow = simNowOf(clock, deps.wallClock().getTime());
        return { clock, simNow, atSim: simNow.toISOString() };
      },
    };
  }

  return async (raw, options = {}) => {
    const correlationId = correlationIdFrom(options.correlationId);
    const log = deps.loggerFor(correlationId).child({ service: "services", handler: spec.name });
    try {
      const { caller, fields } = await admit(raw, log, correlationId);
      const parsed = spec.input.safeParse(fields);
      if (!parsed.success) {
        const paths = issuePaths(parsed.error);
        log.warn("invalid input", { paths });
        throw new ToolError("INVALID", `invalid input: ${paths.join(", ")}`, HANDLER_REASON.VALIDATION);
      }
      const result = await spec.run(contextOf(caller, parsed.data, log, correlationId));
      return ok(result);
    } catch (error) {
      const failure = failureOf(error);
      log.warn("handler refused", { code: failure.error.code, ...(failure.error.reason === undefined ? {} : { reason: failure.error.reason }) });
      return failure;
    }
  };
}

/** The strict object every handler input is: its fields only (the kit takes `caller` apart). */
export function strictInput<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}
