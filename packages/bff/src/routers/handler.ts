// Lambda entry point of the console BFF (Function URL behind the Router with OAC, payload format 2.0).
// infra/bff.ts points at `packages/bff/src/routers/handler.handler`. The first step of every route,
// before the JWT is verified or anything is routed (ADR-0015 §3.1, signup/edge.ts): the distribution's
// `X-Origin-Verify` (403 without it) and no `signup.*` inside a batch or behind an encoded path (400).
import type { AnyTRPCRouter } from "@trpc/server";
import { awsLambdaRequestHandler } from "@trpc/server/adapters/aws-lambda";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context as LambdaContext } from "aws-lambda";
import { describeError } from "../auth/errors";
import { createLogger } from "../lib/log";
import { type EdgeGuard, edgeCheck, lambdaEdgeGuard, routeFacts } from "../signup/edge";
import { appRouter } from "./index";
import { type Context, type CreateContextOptions, createContext } from "./trpc";

/** Path the Router forwards to this function; the web client calls `/api/<procedure>`. */
export const API_PREFIX = "/api";

// The adapter takes the procedure name from `rawPath`. Behind the Router it arrives as
// `/api/operations.list`; called on the Function URL directly (smoke tests) it is `/operations.list`.
export function stripApiPrefix(event: APIGatewayProxyEventV2): APIGatewayProxyEventV2 {
  const { rawPath } = event;
  if (rawPath !== API_PREFIX && !rawPath.startsWith(`${API_PREFIX}/`)) return event;
  const stripped = rawPath.slice(API_PREFIX.length) || "/";
  return { ...event, rawPath: stripped, requestContext: { ...event.requestContext, http: { ...event.requestContext.http, path: stripped } } };
}

// Failures that are the caller's doing are logged where they are refused (routers/trpc.ts).
const EXPECTED = new Set(["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST", "NOT_FOUND", "CONFLICT", "PRECONDITION_FAILED", "TOO_MANY_REQUESTS"]);

export type BffHandler = (event: APIGatewayProxyEventV2, context: LambdaContext) => Promise<APIGatewayProxyStructuredResultV2>;

export function createHandler(router: AnyTRPCRouter, contextOf: (options: CreateContextOptions) => Promise<Context>, edge: EdgeGuard): BffHandler {
  const trpcHandler = awsLambdaRequestHandler<AnyTRPCRouter, APIGatewayProxyEventV2>({
    router,
    createContext: ({ event }) => contextOf({ event }),
    // Responses carry data of one firm: neither CloudFront nor the browser may keep them.
    responseMeta: () => ({ headers: { "cache-control": "no-store" } }),
    onError({ error, path, ctx }) {
      if (EXPECTED.has(error.code)) return;
      // The input is never logged: it may carry names, contacts or free text of a party.
      // Untyped for a generic router; it is whatever `contextOf` returned, or nothing if that failed.
      const context: Context | undefined = ctx;
      const log = context?.log ?? createLogger({ bindings: { service: "bff" } });
      log.error("console.procedure.failed", { path: path ?? "unknown", code: error.code, ...describeError(error.cause ?? error) });
    },
  });
  return async (event, context) => {
    const refused = edgeCheck(edge, event.headers, routeFacts(event.rawPath, event.rawQueryString, event.queryStringParameters));
    if (refused !== undefined) {
      createLogger({ bindings: { service: "bff" } }).warn("console.edge.refused", { status: refused.statusCode });
      return refused;
    }
    return trpcHandler(stripApiPrefix(event), context);
  };
}

export const handler: BffHandler = createHandler(appRouter, createContext, lambdaEdgeGuard);
