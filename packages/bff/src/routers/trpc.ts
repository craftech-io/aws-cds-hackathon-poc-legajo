// tRPC v11 foundation of the console BFF: request context, principal and the procedure builders
// every feature router starts from (docs/architecture.md §10).
//
//   publicProcedure       no principal required (only the health probe)
//   firmProcedure         verified id token with firm and role; an inactive broker is refused; every
//                         id of the input is fenced to the principal's firm (403 + AuditLog DENY
//                         CROSS_FIRM, auth/scope.ts); an input the fence cannot check whole is
//                         refused (403 + AuditLog DENY INPUT_TOO_LARGE); a judge's call keeps the
//                         world's `lastSession` fresh (judge-activity.ts)
//   brokerProcedure       firm + role BROKER or JUDGE (a judge acts as broker in its own judge firm);
//                         any other role: 403 + AuditLog DENY ROLE_NOT_ALLOWED
//   recentLoginProcedure  broker + interactive sign-in at most 15 minutes old, 60 s of skew, real
//                         clock (approve, reopen)
//
// `firmId` and `role` come from the token (or the broker row), never from the input. The same
// middlewares run for the Lambda (`createContext`, verified JWT) and for `createCaller` with a
// principal built on the server (`serverContext`, the `QaDriver`'s console actions).
import { TRPCError, initTRPC } from "@trpc/server";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { APPROVER_ROLES, type ConsoleRole } from "@legajo/shared";
import { type AuditedRefusal, denialDecision } from "../auth/denials";
import { AUTH_REASON, AUTH_REFUSAL, AuthError, type AuthRefusal, describeError } from "../auth/errors";
import { bearerToken } from "../auth/jwt";
import { type Principal, isSignInFresh, principalFromClaims, withBrokerRow } from "../auth/principal";
import type { BrokerMatch } from "../auth/staff";
import { type FencedId, type FirmOwnership, createFirmOwnership, crossFirmTarget, fencedIdOf, fencedIdsOf } from "../auth/scope";
import { type Logger, correlationIdFrom } from "../lib/log";
import { type ContextDeps, defaultDeps } from "./deps";
import { reasonOf, toTrpcError } from "./errors";
import { refreshJudgeActivity } from "./judge-activity";

export interface Context {
  readonly correlationId: string;
  /** `null` when the request carries no acceptable token; `authFailure` says why. */
  readonly principal: Principal | null;
  readonly authFailure: AuthError | null;
  readonly deps: ContextDeps;
  readonly log: Logger;
}

/** The firm fence, for ids a procedure reaches by other means than its input (a message's operation). */
export interface FirmScope {
  /** 403 + `AuditLog DENY CROSS_FIRM` unless `firmId` is the principal's firm. */
  assertFirm(firmId: string, target?: FencedId): Promise<void>;
  /** The same check for one id, resolving its owner; an id that does not exist passes. */
  assertId(id: string): Promise<void>;
}

export interface FirmContext extends Context {
  readonly principal: Principal;
  readonly authFailure: null;
  readonly firmScope: FirmScope;
}

export interface CreateContextOptions {
  readonly event: Pick<APIGatewayProxyEventV2, "headers"> & { readonly requestContext?: { readonly requestId?: string } };
}

const CORRELATION_HEADER = "x-correlation-id";

function header(headers: APIGatewayProxyEventV2["headers"], name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

// The id the console sent, else the Function URL request id, else a fresh one.
function correlationIdOf(event: CreateContextOptions["event"]): string {
  return correlationIdFrom(header(event.headers, CORRELATION_HEADER) ?? event.requestContext?.requestId);
}

/**
 * Builds `createContext` over explicit dependencies (tests, the local UI server). It never throws
 * for a bad token: the failure is kept in the context and `firmProcedure` turns it into the right
 * HTTP status, so public procedures keep working.
 */
export function createContextFactory(resolveDeps: () => ContextDeps) {
  return async ({ event }: CreateContextOptions): Promise<Context> => {
    const deps = resolveDeps();
    const correlationId = correlationIdOf(event);
    const log = deps.loggerFor(correlationId);
    try {
      const claims = await deps.verifier.verify(bearerToken(header(event.headers, "authorization")));
      return { correlationId, principal: principalFromClaims(claims), authFailure: null, deps, log };
    } catch (error) {
      const authFailure =
        error instanceof AuthError ? error : new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "authentication failed unexpectedly", { cause: error });
      return { correlationId, principal: null, authFailure, deps, log };
    }
  };
}

/** `createContext(event)` → `{ principal }` over the linked resources of the BFF Lambda. */
export const createContext = createContextFactory(defaultDeps);

export interface ServerContextInput {
  /** Built on the server (auth/principal.ts `qaPrincipal`), never from a request. */
  readonly principal: Principal;
  readonly deps: ContextDeps;
  /** The caller's correlation id (the `QaDriver`'s idempotency key); a fresh one when it does not look like one. */
  readonly correlationId?: string;
}

/** Context for `createCaller`: the procedures and every middleware run exactly as over HTTP. */
export function serverContext(input: ServerContextInput): Context {
  const correlationId = correlationIdFrom(input.correlationId);
  return { correlationId, principal: input.principal, authFailure: null, deps: input.deps, log: input.deps.loggerFor(correlationId) };
}

const t = initTRPC.context<Context>().create({
  // Stack traces never travel to the browser, whatever NODE_ENV says inside the Lambda.
  isDev: false,
  errorFormatter({ shape, error, ctx }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        reason: error.cause instanceof AuthError ? error.cause.reason : reasonOf(error.cause),
        correlationId: ctx?.correlationId ?? null,
        zodError: error.cause instanceof z.ZodError ? z.flattenError(error.cause) : null,
      },
    };
  },
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;

// Procedures throw the domain's typed errors (ToolError, ConnectorError); here they become the HTTP
// answer their code stands for instead of a 500 (errors.ts).
const domainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const mapped = toTrpcError(result.error.cause);
    if (mapped) throw mapped;
  }
  return result;
});

const baseProcedure = t.procedure.use(domainErrors);

export const publicProcedure = baseProcedure;

const TRPC_CODE: Readonly<Record<AuthRefusal, TRPCError["code"]>> = { UNAUTHENTICATED: "UNAUTHORIZED", FORBIDDEN: "FORBIDDEN", UNAVAILABLE: "SERVICE_UNAVAILABLE" };

function refuse(log: Logger, path: string, error: AuthError): never {
  const fields = { path, reason: error.reason, ...(error.unavailable ? describeError(error.cause) : {}) };
  if (error.unavailable) log.error("console.auth.unavailable", fields);
  else log.warn("console.auth.refused", fields);
  throw new TRPCError({ code: TRPC_CODE[AUTH_REFUSAL[error.reason]], message: error.message, cause: error });
}

interface AuditedContext {
  readonly principal: Principal;
  readonly deps: ContextDeps;
  readonly log: Logger;
  readonly correlationId: string;
}

// The refusal is written to the firm's audit log first; a log that cannot be written never turns a
// 403 into a pass or a 500.
async function refuseAudited(ctx: AuditedContext, path: string, refusal: AuditedRefusal, message: string, target?: FencedId): Promise<never> {
  try {
    const decision = denialDecision({ principal: ctx.principal, refusal, path, correlationId: ctx.correlationId, at: ctx.deps.wallClock(), message, ...(target ? { target } : {}) });
    await ctx.deps.connector.audit.record(decision);
  } catch (error) {
    ctx.log.error("console.audit.failed", { path, refusal, ...describeError(error) });
  }
  return refuse(ctx.log, path, new AuthError(AUTH_REASON[refusal], message));
}

const CROSS_FIRM_MESSAGE = "this belongs to another firm";

/** `account.session`: the one call that must read the judge world's last session before refreshing it. */
const SIGN_IN_CHECK_PATH = "account.session";
const INPUT_TOO_LARGE_MESSAGE = "this request names too much at once";

function firmScopeOf(ctx: AuditedContext, path: string, ownership: FirmOwnership): FirmScope {
  const assertFirm = async (firmId: string, target?: FencedId): Promise<void> => {
    if (firmId !== ctx.principal.firmId) await refuseAudited(ctx, path, "CROSS_FIRM", CROSS_FIRM_MESSAGE, target);
  };
  return {
    assertFirm,
    async assertId(id) {
      const target = fencedIdOf(id);
      if (target === undefined) return;
      const owner = await ownership.firmOf(target);
      if (owner !== undefined) await assertFirm(owner, target);
    },
  };
}

export const firmProcedure = baseProcedure.use(async ({ ctx, next, path, getRawInput }) => {
  const { principal: claimed, authFailure } = ctx;
  if (!claimed) return refuse(ctx.log, path, authFailure ?? new AuthError(AUTH_REASON.TOKEN_MISSING, "missing bearer token"));

  const log = ctx.log.child({ sub: claimed.sub, firmId: claimed.firmId, role: claimed.role });
  let match: BrokerMatch | undefined;
  try {
    match = await ctx.deps.brokers.find(claimed.firmId, claimed.sub);
  } catch (error) {
    return refuse(log, path, new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "could not read the broker directory", { cause: error }));
  }
  let principal: Principal;
  try {
    principal = withBrokerRow(claimed, match);
  } catch (error) {
    if (error instanceof AuthError) return refuse(log, path, error);
    throw error;
  }

  const audited: AuditedContext = { principal, deps: ctx.deps, log, correlationId: ctx.correlationId };
  const ownership = createFirmOwnership(ctx.deps.connector);
  // Every id the input names is checked before the procedure reads anything (FL-082); an input past
  // the fence's bounds is refused whole instead of checked in part.
  const fenced = fencedIdsOf(await getRawInput());
  if (!fenced.ok) return refuseAudited(audited, path, "INPUT_TOO_LARGE", `${INPUT_TOO_LARGE_MESSAGE} (${fenced.limit})`);
  const target = await crossFirmTarget(principal.firmId, fenced.ids, ownership);
  if (target) await refuseAudited(audited, path, "CROSS_FIRM", CROSS_FIRM_MESSAGE, target);

  // The sign-in check compares with the last session before it records this one (account.ts).
  if (path !== SIGN_IN_CHECK_PATH) await refreshJudgeActivity(ctx.deps.connector, principal, ctx.deps.wallClock(), log);

  const firmContext: FirmContext = { ...ctx, principal, authFailure: null, log, firmScope: firmScopeOf(audited, path, ownership) };
  return next({ ctx: firmContext });
});

async function enforceRole(ctx: FirmContext, path: string, roles: readonly ConsoleRole[]): Promise<void> {
  if (roles.includes(ctx.principal.role)) return;
  await refuseAudited(ctx, path, "ROLE_NOT_ALLOWED", `this procedure needs one of: ${roles.join(", ")}`);
}

/** Firm + role BROKER or JUDGE. */
export const brokerProcedure = firmProcedure.use(async ({ ctx, next, path }) => {
  await enforceRole(ctx, path, APPROVER_ROLES);
  return next();
});

/** Broker + a recent interactive sign-in (real clock, ADR-0010): approving and reopening a file. */
export const recentLoginProcedure = brokerProcedure.use(({ ctx, next, path }) => {
  if (!isSignInFresh(ctx.principal, ctx.deps.wallClock())) {
    refuse(ctx.log, path, new AuthError(AUTH_REASON.LOGIN_NOT_RECENT, "enter your password again to continue"));
  }
  return next();
});
