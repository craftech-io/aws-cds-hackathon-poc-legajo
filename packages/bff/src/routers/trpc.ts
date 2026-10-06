// tRPC v11 foundation of the console BFF: request context, principal and the procedure builders
// every feature router starts from (docs/architecture.md §10, ADR-0015 §3.1 and §4).
//
//   publicProcedure          no principal required (only the health probe)
//   signupProcedure          (routers/signup.ts) no token: `signup.*` only, on its exact route without
//                            `batch`, with the viewer IP of `CloudFront-Viewer-Address`
//   guestBootstrapProcedure  a verified token of a GUEST, with or without a firm yet (`account.*` of the
//                            first sign-in: the world may not exist)
//   accountProcedure         what is about the account itself and not about a world (its preferences): a
//                            guest with or without a world (a verified token is enough, like
//                            guestBootstrapProcedure), or staff through the firm gate of `firmProcedure`;
//                            `ctx.sub` is the Cognito `sub` of the token
//   firmProcedure            verified id token with firm and role; an inactive broker is refused; a guest
//                            fails closed unless its broker row exists, is active and carries the token's
//                            firm and world lease (403 `GUEST_WORLD_GONE`); every id of the input is
//                            fenced to the principal's firm (403 + AuditLog DENY CROSS_FIRM,
//                            auth/scope.ts); an input the fence cannot check whole is refused (403 +
//                            AuditLog DENY INPUT_TOO_LARGE); a guest's call keeps the world's
//                            `lastSession` fresh (guest-activity.ts)
//   brokerProcedure          firm + role BROKER or GUEST (a guest acts as broker in its own guest firm);
//                            any other role: 403 + AuditLog DENY ROLE_NOT_ALLOWED
//   recentLoginProcedure     broker + interactive sign-in at most 15 minutes old, 60 s of skew, real
//                            clock (approve, reopen)
//
// The id token travels in `X-Legajo-Auth: Bearer <idToken>`: CloudFront signs the origin request
// (OAC) and replaces `Authorization`. `firmId` and `role` come from the token (or the broker row),
// never from the input. The same middlewares run for the Lambda (`createContext`, verified JWT) and for
// `createCaller` with a principal built on the server (`serverContext`, the `QaDriver`'s console
// actions). The origin check and the refusal of batches with a `signup.*` run before any of this, in
// handler.ts.
import { TRPCError, initTRPC } from "@trpc/server";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { z } from "zod";
import { APPROVER_ROLES, type ConsoleRole, ERROR_REASON, ToolError } from "@legajo/shared";
import { QuotaExceededError } from "@legajo/shared/errors";
import { type AuditedRefusal, denialDecision } from "../auth/denials";
import { AUTH_REASON, AUTH_REFUSAL, AuthError, type AuthRefusal, describeError } from "../auth/errors";
import { type IdTokenClaims, bearerToken } from "../auth/jwt";
import { type GuestBootstrap, type Principal, guestFromClaims, guestOfPrincipal, guestRowRefusal, isSignInFresh, principalFromClaims, withBrokerRow } from "../auth/principal";
import type { BrokerMatch } from "../auth/staff";
import { type FencedId, type FirmOwnership, createFirmOwnership, crossFirmTarget, fencedIdOf, fencedIdsOf } from "../auth/scope";
import { type Logger, correlationIdFrom } from "../lib/log";
import { VIEWER_ADDRESS_HEADER, type ViewerIp, headerValue, parseViewerAddress } from "../lib/viewer-ip";
import { type AccessDeps, defaultAccessDeps } from "../signup/deps";
import { routeFacts } from "../signup/edge";
import { type ContextDeps, defaultDeps } from "./deps";
import { reasonOf, toTrpcError } from "./errors";
import { refreshGuestActivity } from "./guest-activity";

/** What the request itself says, trusted only behind the origin check of handler.ts. */
export interface RequestFacts {
  /** The viewer's IP from `CloudFront-Viewer-Address`; absent in process (`serverContext`) or when missing. */
  readonly viewer?: ViewerIp;
  /** Procedures the route names and whether it asked for a batch (signup/edge.ts). */
  readonly procedures: readonly string[];
  readonly batch: boolean;
  readonly encoded: boolean;
}

export interface Context {
  readonly correlationId: string;
  /** `null` when the request carries no acceptable token; `authFailure` says why. */
  readonly principal: Principal | null;
  readonly authFailure: AuthError | null;
  /** The verified claims, even when they make no firm principal (a guest before its world). */
  readonly claims: IdTokenClaims | null;
  readonly request: RequestFacts;
  readonly deps: ContextDeps;
  /** Sign-up, leads and guest-world stores, built on first use (signup/deps.ts). */
  readonly access: () => AccessDeps;
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
  readonly event: Pick<APIGatewayProxyEventV2, "headers"> &
    Partial<Pick<APIGatewayProxyEventV2, "rawPath" | "rawQueryString" | "queryStringParameters">> & { readonly requestContext?: { readonly requestId?: string } };
}

const CORRELATION_HEADER = "x-correlation-id";
/** Header of the id token behind the Router: CloudFront replaces `Authorization` when it signs (OAC). */
export const AUTH_HEADER = "x-legajo-auth";

function header(headers: APIGatewayProxyEventV2["headers"], name: string): string | undefined {
  return headerValue(headers, name);
}

function requestFactsOf(event: CreateContextOptions["event"]): RequestFacts {
  const facts = routeFacts(event.rawPath ?? "/", event.rawQueryString, event.queryStringParameters);
  const viewer = parseViewerAddress(header(event.headers, VIEWER_ADDRESS_HEADER));
  return { procedures: facts.procedures, batch: facts.batch, encoded: facts.encoded, ...(viewer === undefined ? {} : { viewer }) };
}

/** Facts of a call made in process (`serverContext`): no route, no viewer. */
export const IN_PROCESS: RequestFacts = Object.freeze({ procedures: [], batch: false, encoded: false });

// The id the console sent, else the Function URL request id, else a fresh one.
function correlationIdOf(event: CreateContextOptions["event"]): string {
  return correlationIdFrom(header(event.headers, CORRELATION_HEADER) ?? event.requestContext?.requestId);
}

/**
 * Builds `createContext` over explicit dependencies (tests, the local UI server). It never throws
 * for a bad token: the failure is kept in the context and `firmProcedure` turns it into the right
 * HTTP status, so public procedures keep working.
 */
export function createContextFactory(resolveDeps: () => ContextDeps, resolveAccess: () => AccessDeps = defaultAccessDeps) {
  return async ({ event }: CreateContextOptions): Promise<Context> => {
    const deps = resolveDeps();
    const correlationId = correlationIdOf(event);
    const log = deps.loggerFor(correlationId);
    const base = { correlationId, request: requestFactsOf(event), deps, access: resolveAccess, log };
    let claims: IdTokenClaims | null = null;
    try {
      claims = await deps.verifier.verify(bearerToken(header(event.headers, AUTH_HEADER)));
      return { ...base, claims, principal: principalFromClaims(claims), authFailure: null };
    } catch (error) {
      const authFailure =
        error instanceof AuthError ? error : new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "authentication failed unexpectedly", { cause: error });
      return { ...base, claims, principal: null, authFailure };
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
  /** Sign-up and guest stores, for the callers that need them (tests of `account.*`). */
  readonly access?: () => AccessDeps;
}

/** Context for `createCaller`: the procedures and every middleware run exactly as over HTTP. */
export function serverContext(input: ServerContextInput): Context {
  const correlationId = correlationIdFrom(input.correlationId);
  return {
    correlationId,
    principal: input.principal,
    authFailure: null,
    claims: null,
    request: IN_PROCESS,
    deps: input.deps,
    access: input.access ?? defaultAccessDeps,
    log: input.deps.loggerFor(correlationId),
  };
}

const t = initTRPC.context<Context>().create({
  // Stack traces never travel to the browser, whatever NODE_ENV says inside the Lambda.
  isDev: false,
  errorFormatter({ shape, error, ctx }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        reason: error.cause instanceof AuthError ? error.cause.reason : error.cause instanceof QuotaExceededError ? error.cause.reason : (reasonOf(error.cause) ?? (error.cause instanceof z.ZodError ? "INVALID" : null)),
        correlationId: ctx?.correlationId ?? null,
        zodError: error.cause instanceof z.ZodError ? z.flattenError(error.cause) : null,
        // `QUOTA_EXCEEDED {kind, resetsAtReal}` of a guest world (ADR-0015 §4): the console disables what it names.
        ...(error.cause instanceof QuotaExceededError ? { quota: { kind: error.cause.kind, resetsAtReal: error.cause.resetsAtReal } } : {}),
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
    const { cause } = result.error;
    if (cause instanceof QuotaExceededError) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: cause.message, cause });
    const mapped = toTrpcError(cause);
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
const GUEST_WORLD_GONE_MESSAGE = "this demo world is no longer yours: prepare a new one";

interface GuestMatch extends BrokerMatch {
  readonly firmId: string;
  readonly leaseId?: string;
}

async function guestRowOf(ctx: Context, principal: Principal): Promise<GuestMatch | undefined> {
  const row = await ctx.deps.connector.firms.findBrokerBySub(principal.firmId, principal.sub);
  return row === undefined ? undefined : { brokerId: row.brokerId, role: row.role, active: row.active, firmId: row.firmId, ...(row.leaseId === undefined ? {} : { leaseId: row.leaseId }) };
}

/** The refusal of a guest whose world is gone (ADR-0015 §4); `account.session` tells it apart. */
export function isGuestWorldGone(error: unknown): boolean {
  return error instanceof TRPCError && error.cause instanceof ToolError && error.cause.reason === ERROR_REASON.GUEST_WORLD_GONE;
}

// ADR-0015 §4: a guest's token works only for the world its broker row still names (fails closed).
function assertGuestWorld(principal: Principal, row: GuestMatch | undefined, path: string, log: Logger): void {
  const refusal = guestRowRefusal(principal, row);
  if (refusal === undefined) return;
  log.warn("console.guest.world_gone", { path, refusal });
  throw new TRPCError({ code: "FORBIDDEN", message: GUEST_WORLD_GONE_MESSAGE, cause: new ToolError("FORBIDDEN", GUEST_WORLD_GONE_MESSAGE, ERROR_REASON.GUEST_WORLD_GONE) });
}

/** `account.session`: the one call that must read the guest world's last session before refreshing it. */
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

/**
 * Everything `firmProcedure` checks, as a function: `account.session` runs it too for a guest whose
 * world may be gone (routers/account.ts). Throws the refusal; returns the firm context.
 */
export async function enterFirm(ctx: Context, path: string, getRawInput: () => Promise<unknown>): Promise<FirmContext> {
  const { principal: claimed, authFailure } = ctx;
  if (!claimed) return refuse(ctx.log, path, authFailure ?? new AuthError(AUTH_REASON.TOKEN_MISSING, "missing bearer token"));

  const log = ctx.log.child({ sub: claimed.sub, firmId: claimed.firmId, role: claimed.role });
  let match: GuestMatch | BrokerMatch | undefined;
  try {
    // A guest's row is read every time: destroying its world must refuse its tokens at once.
    match = claimed.isGuest ? await guestRowOf(ctx, claimed) : await ctx.deps.brokers.find(claimed.firmId, claimed.sub);
  } catch (error) {
    return refuse(log, path, new AuthError(AUTH_REASON.AUTH_UNAVAILABLE, "could not read the broker directory", { cause: error }));
  }
  if (claimed.isGuest) assertGuestWorld(claimed, match as GuestMatch | undefined, path, log);
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
  if (path !== SIGN_IN_CHECK_PATH) await refreshGuestActivity(ctx.deps.connector, principal, ctx.deps.wallClock(), log);

  return { ...ctx, principal, authFailure: null, log, firmScope: firmScopeOf(audited, path, ownership) };
}

export const firmProcedure = baseProcedure.use(async ({ ctx, next, path, getRawInput }) => next({ ctx: await enterFirm(ctx, path, getRawInput) }));

async function enforceRole(ctx: FirmContext, path: string, roles: readonly ConsoleRole[]): Promise<void> {
  if (roles.includes(ctx.principal.role)) return;
  await refuseAudited(ctx, path, "ROLE_NOT_ALLOWED", `this procedure needs one of: ${roles.join(", ")}`);
}

/** Firm + role BROKER or GUEST. */
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

// ---- The account itself (preferences) ------------------------------------------------------------------

export interface AccountContext extends Context {
  /** Cognito `sub` of the verified token: the key of the account's own rows. */
  readonly sub: string;
}

/**
 * A procedure about the account, not about a world: it must work for a guest whose world does not exist
 * yet or was destroyed (the preferences outlive it) and for staff, who go through the firm gate (an
 * inactive broker is refused). The `sub` always comes from the token, never from the input.
 */
export const accountProcedure = baseProcedure.use(async ({ ctx, next, path, getRawInput }) => {
  const guest = ctx.claims !== null ? guestFromClaims(ctx.claims) : ctx.principal === null ? undefined : guestOfPrincipal(ctx.principal);
  if (guest !== undefined) {
    const guestContext: AccountContext = { ...ctx, sub: guest.sub };
    return next({ ctx: guestContext });
  }
  const firm = await enterFirm(ctx, path, getRawInput);
  const accountContext: AccountContext & FirmContext = { ...firm, sub: firm.principal.sub };
  return next({ ctx: accountContext });
});

// ---- Public sign-up and the guest's bootstrap (ADR-0015 §1, §3.1 and §4) ------------------------------

export interface GuestContext extends Context {
  readonly guest: GuestBootstrap;
}

/** A verified GUEST token, with or without a firm: what `account.session`, `ensureWorld`, `world` and `usage` accept. */
export const guestBootstrapProcedure = baseProcedure.use(({ ctx, next, path }) => {
  if (ctx.claims === null) return refuse(ctx.log, path, ctx.authFailure ?? new AuthError(AUTH_REASON.TOKEN_MISSING, "missing bearer token"));
  const guest = guestFromClaims(ctx.claims);
  if (guest === undefined) return refuse(ctx.log, path, new AuthError(AUTH_REASON.ROLE_NOT_ALLOWED, "this procedure is for guest accounts"));
  const guestContext: GuestContext = { ...ctx, guest };
  return next({ ctx: guestContext });
});
