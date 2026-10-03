// `console.*` actions of the `QaDriver` (docs/tool-catalog.md): the real `appRouter` through
// `createCaller`, as a firm-qa user built on the server (`qaPrincipal`: `brk-qa-runner` BROKER or
// `brk-qa-analyst` ANALYST, with the sign-in age the scenario asks for), so `firmProcedure`,
// `brokerProcedure` and `recentLoginProcedure` run for real. Only the JWT signature is skipped: the
// driver never receives a token, and its context has no verifier that could accept one.
import { TRPCError } from "@trpc/server";
import { ToolError, type ErrorCode } from "@legajo/shared";
import { AUTH_REASON, AuthError } from "../auth/errors";
import { qaPrincipal } from "../auth/principal";
import { brokerLookupOf, createBrokerDirectory } from "../auth/staff";
import type { Connector } from "../connector/index";
import { type Logger, createLogger } from "../lib/log";
import { type ConsoleServices, bindConsoleServices } from "../routers/console-services";
import { appRouter, createConsoleCaller } from "../routers/index";
import type { ContextDeps } from "../routers/deps";
import type { DocumentUrlSigner } from "../routers/document-url";
import { serverContext } from "../routers/trpc";
import type { QaParsedInput } from "./contract-inputs";

type ProcedureKind = "query" | "mutation" | "subscription";

/** Query or mutation of a console procedure; `undefined` when the router has no such path. */
export function procedureKind(path: string): ProcedureKind | undefined {
  const procedures = appRouter._def.procedures as Readonly<Record<string, { readonly _def?: { readonly type?: ProcedureKind } } | undefined>>;
  return Object.hasOwn(procedures, path) ? procedures[path]?._def?.type : undefined;
}

export interface QaConsoleDeps {
  readonly data: Connector;
  readonly documents: DocumentUrlSigner;
  readonly whatsappMode: ContextDeps["whatsappMode"];
  /** Real time: the sign-in age and the audit stamps. */
  readonly now: () => Date;
  /** One logger per call; a JSON logger bound to the call's correlation id by default. */
  readonly loggerFor?: (correlationId: string) => Logger;
  /** The console's services (tests, local flows); the stage's, with caller `QA`, by default (routers/console-services.ts). */
  readonly services?: ConsoleServices;
}

/** Context dependencies of a driver's console call: no verifier accepts a token, nothing is probed. */
export function qaContextDeps(deps: QaConsoleDeps): ContextDeps {
  const context: ContextDeps = {
    verifier: { verify: () => Promise.reject(new AuthError(AUTH_REASON.TOKEN_INVALID, "the QA driver never verifies tokens")) },
    brokers: createBrokerDirectory(brokerLookupOf(deps.data.firms), deps.now),
    connector: deps.data,
    totp: { isTotpEnabled: () => Promise.resolve(false) },
    documents: deps.documents,
    whatsappMode: deps.whatsappMode,
    health: [],
    wallClock: deps.now,
    loggerFor: deps.loggerFor ?? ((correlationId) => createLogger({ correlationId, bindings: { service: "qa-driver", principal: "qa" } })),
  };
  return deps.services === undefined ? context : bindConsoleServices(context, deps.services);
}

const TRPC_TO_CODE: Readonly<Partial<Record<TRPCError["code"], ErrorCode>>> = {
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  UNAUTHORIZED: "FORBIDDEN",
  BAD_REQUEST: "INVALID",
  PRECONDITION_FAILED: "POLICY_DENIED",
  CONFLICT: "CONFLICT",
  TOO_MANY_REQUESTS: "UNAVAILABLE",
  SERVICE_UNAVAILABLE: "UNAVAILABLE",
};

/** The console's refusal as the driver reports it: the tRPC code mapped back, and the console's `reason`. */
export function consoleFailure(error: TRPCError): ToolError {
  const cause = error.cause;
  const reason = cause instanceof AuthError ? cause.reason : cause instanceof ToolError ? (cause.reason ?? cause.code) : error.code;
  const code = cause instanceof ToolError ? cause.code : (TRPC_TO_CODE[error.code] ?? "UNAVAILABLE");
  return new ToolError(code, error.message, reason);
}

type Callable = (input?: unknown) => Promise<unknown>;

/** Runs `procedure` of the `appRouter` with the server-built QA principal. */
export async function callConsole(deps: QaConsoleDeps, call: QaParsedInput<"console">, correlationId: string): Promise<unknown> {
  if (procedureKind(call.procedure) === undefined) throw new ToolError("NOT_FOUND", `the console has no procedure ${call.procedure}`);
  const now = deps.now();
  const principal = qaPrincipal({ role: call.role, now, authTime: new Date(now.getTime() - call.authTimeAgoSec * 1_000) });
  const caller = createConsoleCaller(serverContext({ principal, deps: qaContextDeps(deps), correlationId })) as unknown as Record<string, unknown>;
  const target = call.procedure.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], caller) as Callable;
  try {
    return await target(call.input);
  } catch (error) {
    if (error instanceof TRPCError) throw consoleFailure(error);
    throw error;
  }
}
