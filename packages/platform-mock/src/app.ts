// The platform mock as a function of a request (docs/architecture-integrations.md §6): route table,
// method check, error mapping and one log line per request. It has no admin routes: the rows of each
// world are written by the world factory (schema.ts), and the mock only reads them and applies the
// changes its two POST routes describe.
import { ConnectorError } from "@legajo/shared";
import { CORRELATION_HEADER } from "./api";
import { newPlatformEventId } from "./events";
import { PlatformHttpError, errorResponse, fromConnectorError, headerValue, type PlatformRequest, type PlatformResponse } from "./http";
import { correlationIdOf, stdoutSink, type PlatformLogFields, type PlatformLogLevel } from "./log";
import { customsStatusRoute, etaRoute, getOperationRoute, healthRoute, type PlatformAppDeps, type ResolvedDeps, type RouteContext } from "./routes";

export type { PlatformAppDeps } from "./routes";

export interface PlatformApp {
  handle(request: PlatformRequest): Promise<PlatformResponse>;
}

export interface PlatformRoute {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  readonly run: (ctx: RouteContext) => Promise<PlatformResponse>;
}

/** Every route of the mock; a path that matches with another method answers 405. */
export const PLATFORM_ROUTES: readonly PlatformRoute[] = [
  { name: "health", method: "GET", pattern: /^\/v1\/health$/, run: healthRoute },
  { name: "operation", method: "GET", pattern: /^\/v1\/operations\/([^/]+)$/, run: getOperationRoute },
  { name: "eta", method: "POST", pattern: /^\/v1\/operations\/([^/]+)\/eta$/, run: etaRoute },
  { name: "customs-status", method: "POST", pattern: /^\/v1\/operations\/([^/]+)\/customs-status$/, run: customsStatusRoute },
];

function splitUrl(url: string): { path: string; query: URLSearchParams } {
  const at = url.indexOf("?");
  return at === -1 ? { path: url, query: new URLSearchParams() } : { path: url.slice(0, at), query: new URLSearchParams(url.slice(at + 1)) };
}

function toHttpError(error: unknown): PlatformHttpError {
  if (error instanceof PlatformHttpError) return error;
  if (error instanceof ConnectorError) return fromConnectorError(error);
  return new PlatformHttpError("INTERNAL", "internal error", undefined, {}, { cause: error });
}

/** Class and code of what failed, for the log line (never its message, which may quote input). */
function errorFields(error: unknown): PlatformLogFields {
  const cause = error instanceof PlatformHttpError && error.cause !== undefined ? error.cause : error;
  if (cause instanceof ConnectorError) return { errorName: cause.name, errorCode: cause.code };
  if (cause instanceof PlatformHttpError) return { errorName: cause.name, errorCode: cause.code };
  return { errorName: cause instanceof Error ? cause.name : "UnknownError" };
}

type LogLine = { -readonly [K in keyof PlatformLogFields]: PlatformLogFields[K] };

function levelOf(status: number): PlatformLogLevel {
  if (status >= 500) return "error";
  return status >= 400 ? "warn" : "info";
}

export function createPlatformApp(deps: PlatformAppDeps): PlatformApp {
  const resolved: ResolvedDeps = {
    ...deps,
    newEventId: deps.newEventId ?? (() => newPlatformEventId(deps.now().getTime())),
    log: deps.log ?? stdoutSink,
  };

  async function dispatch(request: PlatformRequest, fields: LogLine): Promise<PlatformResponse> {
    const { path, query } = splitUrl(request.url);
    const matches = PLATFORM_ROUTES.map((route) => ({ route, match: route.pattern.exec(path) })).filter((candidate) => candidate.match !== null);
    if (matches.length === 0) throw new PlatformHttpError("NOT_FOUND", "no such route");
    const method = request.method.toUpperCase();
    const hit = matches.find((candidate) => candidate.route.method === method);
    if (hit === undefined) {
      const allow = matches.map((candidate) => candidate.route.method).join(", ");
      throw new PlatformHttpError("METHOD_NOT_ALLOWED", `use ${allow}`, undefined, { allow });
    }
    fields.route = hit.route.name;
    const ctx: RouteContext = {
      deps: resolved,
      request,
      query,
      route: hit.route.name,
      pathNumber: hit.match?.[1],
      note: (extra) => {
        Object.assign(fields, extra);
      },
    };
    return hit.route.run(ctx);
  }

  return {
    async handle(request) {
      const correlationId = correlationIdOf(headerValue(request, CORRELATION_HEADER), request.requestId);
      const method = request.method.toUpperCase();
      const fields: LogLine = { method: /^[A-Z]{1,10}$/.test(method) ? method : "OTHER" };
      let response: PlatformResponse;
      let failure: PlatformLogFields = {};
      try {
        response = await dispatch(request, fields);
      } catch (error) {
        const httpError = toHttpError(error);
        response = errorResponse(httpError);
        failure = { ...errorFields(error), ...(httpError.reason === undefined ? {} : { reason: httpError.reason }) };
      }
      resolved.log({
        level: levelOf(response.status),
        time: resolved.now().toISOString(),
        correlationId,
        message: "platform request",
        ...fields,
        status: response.status,
        ...failure,
      });
      return { ...response, headers: { ...response.headers, [CORRELATION_HEADER]: correlationId } };
    },
  };
}
