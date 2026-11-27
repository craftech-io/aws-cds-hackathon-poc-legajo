// The access line of every public HTTP entry (`Bff` and `PublicWeb`, the two Function URLs behind the
// Router): one JSON line per request, written when it ends, also when it was refused before any
// routing (no `X-Origin-Verify`, unknown path, wrong method, a limit) or when the handler threw.
//
//   {"message":"acceso","route","method","status","ip","userAgent","sub","ms", …the logger's own fields}
//
// The fields of the demos' common access line ("msg","ruta","metodo","estado","ip","agente","sub","ms")
// keep this repository's English names; `message` is the logger's key for `msg` (docs/architecture.md
// §12). Never a body, a query string, a token (the upload link's token is cut out of `/u/<token>`), an
// authorization header, an email or a phone. `route` and `userAgent` are truncated and stripped of
// control characters and line separators. `ip` is the viewer's address from `CloudFront-Viewer-Address`
// (lib/viewer-ip.ts, the same parser the rate limits use), never `x-forwarded-for`; this line is the
// only place it is written in clear, and the log groups keep it 14 days (infra/observability-spec.ts).
// `sub` appears only once the request's id token was verified (`noteVerifiedSub`).
import { AsyncLocalStorage } from "node:async_hooks";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { type Logger, createLogger } from "./log";
import { VIEWER_ADDRESS_HEADER, headerValue, parseViewerAddress } from "./viewer-ip";

export const ACCESS_MESSAGE = "acceso";
export const ROUTE_MAX = 120;
export const USER_AGENT_MAX = 80;
const METHOD_MAX = 10;
const SUB_MAX = 64;

interface RequestInFlight {
  sub?: string;
}

const inFlight = new AsyncLocalStorage<RequestInFlight>();

/** Notes the `sub` of the request's verified id token; outside a wrapped request it does nothing. */
export function noteVerifiedSub(sub: string | undefined): void {
  const request = inFlight.getStore();
  if (request !== undefined && sub !== undefined && sub !== "") request.sub = sub;
}

/** No control characters nor line separators, and at most `max` characters. */
export function sanitize(value: string | undefined, max: number): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").slice(0, max);
}

/** The path without its query string, decoded when it can be. */
export function pathOf(event: Pick<APIGatewayProxyEventV2, "rawPath">): string {
  const raw = (event.rawPath || "/").split("?")[0] ?? "/";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** `PublicWeb`'s path with the upload link's token (the only credential of the page) cut out. */
export function publicWebRoute(event: Pick<APIGatewayProxyEventV2, "rawPath">): string {
  return pathOf(event).replace(/^\/u\/[^/]*/, "/u/:token");
}

export interface AccessLogOptions {
  readonly service: string;
  /** The route as logged; never a part that is a credential. */
  readonly route: (event: APIGatewayProxyEventV2) => string;
  /** Tests pass their own; the Lambdas write to stdout at `info`. */
  readonly logger?: () => Logger;
  readonly now?: () => number;
}

type HttpHandler<A extends unknown[]> = (event: APIGatewayProxyEventV2, ...rest: A) => Promise<APIGatewayProxyStructuredResultV2>;

function write(log: Logger, event: APIGatewayProxyEventV2, route: string, status: number, sub: string | undefined, ms: number): void {
  log.info(ACCESS_MESSAGE, {
    route: sanitize(route, ROUTE_MAX),
    method: sanitize(event.requestContext?.http?.method, METHOD_MAX).toUpperCase(),
    status,
    ip: parseViewerAddress(headerValue(event.headers, VIEWER_ADDRESS_HEADER))?.address ?? "",
    userAgent: sanitize(headerValue(event.headers, "user-agent"), USER_AGENT_MAX),
    ...(sub === undefined ? {} : { sub: sanitize(sub, SUB_MAX) }),
    ms,
  });
}

/** Wraps an HTTP handler without changing any answer: logs the access when it ends and rethrows errors. */
export function withAccessLog<A extends unknown[]>(handler: HttpHandler<A>, options: AccessLogOptions): HttpHandler<A> {
  const now = options.now ?? Date.now;
  const loggerOf = options.logger ?? (() => createLogger({ level: "info", bindings: { service: options.service } }));
  return (event, ...rest) => {
    const request: RequestInFlight = {};
    const started = now();
    const record = (status: number) => {
      try {
        write(loggerOf(), event, options.route(event), status, request.sub, Math.max(0, now() - started));
      } catch {
        // The access line never changes the answer.
      }
    };
    return inFlight.run(request, async () => {
      try {
        const response = await handler(event, ...rest);
        record(response.statusCode ?? 200);
        return response;
      } catch (error) {
        record(500);
        throw error;
      }
    });
  };
}
