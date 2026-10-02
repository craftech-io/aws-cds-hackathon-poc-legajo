// Lambda entry of `PublicWeb` (docs/architecture.md §11, Function URL behind the Router on `/u/*`
// with OAC): the importer's upload page, with no login. The first step of every route is the
// distribution's `X-Origin-Verify`, compared in constant time (403 without it, ADR-0015 §3.1); after
// it, the token in the path is the only credential, and every decision derives the firm, operation,
// importer and world from the link row, never from the request. infra/bff.ts points at
// `packages/bff/src/public-web/handler.handler`; the local UI server (tests/ui-server) mounts
// `createPublicWebHandler` with the in-memory connector, an S3 emulator and a test guard.
import { ConnectorError, operationNumberOf } from "@legajo/shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { Connector } from "../connector/index";
import { type Logger, correlationIdFrom, createLogger } from "../lib/log";
import { isOriginVerified } from "../lib/viewer-ip";
import { type EdgeGuard, lambdaEdgeGuard } from "../signup/edge";
import { type ActionContext, done, presign } from "./actions";
import { recordAccess, recordRefusal } from "./audit";
import type { ErrorPageKind } from "./copy";
import { defaultPublicWebDeps } from "./deps";
import { errorPageCsp, renderErrorPage, renderUploadPage, uploadPageCsp } from "./html";
import { type Route, htmlResponse, jsonError, refusalOfPost, requestOf, routeOf } from "./http";
import { type LinkRefusal, type OpenLink, resolveLink } from "./links";
import type { PdfPresigner } from "./presign";

type Response = APIGatewayProxyStructuredResultV2;

export interface PublicWebDeps {
  readonly connector: Connector;
  readonly presigner: PdfPresigner;
  /** Origin of the page (`https://legajo.demo.craftech.io`); a browser POST from any other is refused. */
  readonly appOrigin: string;
  /** Real time: link expiry and the real stamp of each decision (the simulated one comes from the world). */
  readonly wallClock: () => Date;
  /** Lower-case UUID of each object key. */
  readonly newUuid: () => string;
  readonly loggerFor: (correlationId: string) => Logger;
}

export type PublicWebHandler = (event: APIGatewayProxyEventV2) => Promise<Response>;

const PAGE_OF_REFUSAL: Readonly<Record<LinkRefusal, { readonly status: number; readonly page: ErrorPageKind }>> = {
  MALFORMED: { status: 404, page: "notFound" },
  UNKNOWN: { status: 404, page: "notFound" },
  WORLD_GONE: { status: 404, page: "notFound" },
  EXPIRED: { status: 410, page: "expired" },
  WORLD_RESET: { status: 410, page: "expired" },
  USED: { status: 410, page: "used" },
};

function errorPage(status: number, kind: ErrorPageKind): Response {
  return htmlResponse(status, renderErrorPage(kind), errorPageCsp());
}

function methodNotAllowed(allow: "GET" | "POST"): Response {
  if (allow === "POST") return jsonError(405, "INVALID", "METHOD", { allow });
  const response = errorPage(405, "notFound");
  return { ...response, headers: { ...response.headers, allow } };
}

// Only the error's kind reaches the log: connector messages name keys, and a key holds the token.
function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof ConnectorError) return { errorName: error.name, code: error.code, table: error.table };
  return { errorName: error instanceof Error ? error.name : "UnknownError" };
}

async function page(ctx: ActionContext, open: OpenLink): Promise<Response> {
  await recordAccess(ctx, open, "UPLOAD_LINK_OPENED", { pending: open.pending });
  const html = renderUploadPage({ operationNumber: operationNumberOf(open.link.operationId), pending: open.pending });
  return htmlResponse(200, html, uploadPageCsp(ctx.presigner.origin));
}

async function dispatch(ctx: ActionContext, route: Exclude<Route, { kind: "NONE" }>, appOrigin: string): Promise<Response> {
  const isPage = route.kind === "PAGE";
  if (isPage && ctx.request.method !== "GET") return methodNotAllowed("GET");
  if (!isPage) {
    if (ctx.request.method !== "POST") return methodNotAllowed("POST");
    const refusal = refusalOfPost(ctx.request, appOrigin);
    if (refusal !== undefined) {
      ctx.log.warn("public_web.post_refused", { refusal });
      return refusal === "NOT_JSON" ? jsonError(400, "INVALID", refusal) : jsonError(403, "FORBIDDEN", refusal);
    }
  }

  const state = await resolveLink(ctx.data, route.token, ctx.now);
  if (!state.ok) {
    await recordRefusal(ctx, state.refusal, state.known);
    const { status, page: kind } = PAGE_OF_REFUSAL[state.refusal];
    return isPage ? errorPage(status, kind) : jsonError(status, "NOT_FOUND", `LINK_${state.refusal}`);
  }
  if (route.kind === "PAGE") return page(ctx, state);
  return route.kind === "PRESIGN" ? presign(ctx, state) : done(ctx, state);
}

function originVerified(edge: EdgeGuard, event: APIGatewayProxyEventV2): boolean {
  try {
    return isOriginVerified(event.headers, edge.originVerifyKey());
  } catch {
    return false;
  }
}

export function createPublicWebHandler(deps: PublicWebDeps, edge: EdgeGuard): PublicWebHandler {
  return async (event) => {
    if (!originVerified(edge, event)) {
      createLogger({ bindings: { service: "public-web" } }).warn("public_web.edge.refused", { reason: "ORIGIN_NOT_VERIFIED" });
      return jsonError(403, "FORBIDDEN", "ORIGIN_NOT_VERIFIED");
    }
    const request = requestOf(event);
    const correlationId = correlationIdFrom(request.requestId);
    const log = deps.loggerFor(correlationId);
    const route = routeOf(request.path);
    if (route.kind === "NONE") return errorPage(404, "notFound");
    const ctx: ActionContext = { data: deps.connector, log, correlationId, now: deps.wallClock(), request, presigner: deps.presigner, newUuid: deps.newUuid };
    try {
      return await dispatch(ctx, route, deps.appOrigin);
    } catch (error) {
      log.error("public_web.failed", { route: route.kind, ...errorFields(error) });
      return route.kind === "PAGE" ? errorPage(503, "unavailable") : jsonError(503, "UNAVAILABLE", "UNAVAILABLE");
    }
  };
}

let lambdaHandler: PublicWebHandler | undefined;

export const handler: PublicWebHandler = async (event) => {
  try {
    lambdaHandler ??= createPublicWebHandler(defaultPublicWebDeps(), lambdaEdgeGuard);
  } catch {
    // A missing link or secret: the page says "try later" instead of a CloudFront error.
    return errorPage(503, "unavailable");
  }
  return lambdaHandler(event);
};
