// Test-only HTTP drivers of the BFF for the public sign-up (never imported by runtime code): the real
// Lambda entry (routers/handler.ts) over the in-memory connector, the sign-up doubles and the test
// guard, and Function URL events as CloudFront forwards them (with `X-Origin-Verify` and
// `CloudFront-Viewer-Address` unless a test takes them away).
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context as LambdaContext } from "aws-lambda";
import { createTestIssuer, testContextDeps } from "../auth/testing";
import type { MemoryStores } from "../connector/index";
import { createHandler, type BffHandler } from "../routers/handler";
import { appRouter } from "../routers/index";
import { createContextFactory } from "../routers/trpc";
import type { ContextDeps } from "../routers/deps";
import { edgeHeaders, testEdgeGuard, type TestAccess } from "./testing";

export const lambdaContext = { awsRequestId: "lambda-req-signup", getRemainingTimeInMillis: () => 10_000 } as unknown as LambdaContext;

export interface Bff {
  readonly handler: BffHandler;
  readonly deps: ContextDeps;
  readonly issuer: ReturnType<typeof createTestIssuer>;
}

export function bffFor(stores: MemoryStores, access: TestAccess, lines?: string[]): Bff {
  const issuer = createTestIssuer({ now: access.now });
  const deps = testContextDeps({ verifier: issuer.verifier(), stores, now: access.now, ...(lines === undefined ? {} : { lines }) });
  return { handler: createHandler(appRouter, createContextFactory(() => deps, () => access), testEdgeGuard), deps, issuer };
}

export interface EventOptions {
  readonly input?: unknown;
  /** Replaces the edge headers CloudFront adds (pass `{}` to send none). */
  readonly edge?: Record<string, string>;
  readonly headers?: Record<string, string>;
  /** Extra query string, e.g. `batch=1`. */
  readonly query?: string;
}

let sequence = 0;

/** `POST /api/<path>` with the input as the JSON body, or `GET` with `?input=` for a query. */
export function trpcEvent(method: "GET" | "POST", rawPath: string, options: EventOptions = {}): APIGatewayProxyEventV2 {
  const input = options.input === undefined ? undefined : JSON.stringify(options.input);
  const query = [method === "GET" && input !== undefined ? `input=${encodeURIComponent(input)}` : "", options.query ?? ""].filter((part) => part !== "").join("&");
  sequence += 1;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: query,
    ...(query === "" ? {} : { queryStringParameters: Object.fromEntries(new URLSearchParams(query)) }),
    headers: { ...(options.edge ?? edgeHeaders()), "content-type": "application/json", ...options.headers },
    isBase64Encoded: false,
    ...(method === "POST" && input !== undefined ? { body: input } : {}),
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "bff-url.lambda-url.us-east-1.on.aws",
      domainPrefix: "bff-url",
      http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "vitest" },
      requestId: `req-signup-${String(sequence).padStart(4, "0")}`,
      routeKey: "$default",
      stage: "$default",
      time: "14/Oct/2026:13:30:00 +0000",
      timeEpoch: 1792330200000,
    },
  };
}

export interface CallResult {
  readonly status: number;
  readonly data: unknown;
  readonly error: { readonly code?: string; readonly reason?: string | null; readonly zodError?: unknown; readonly quota?: unknown } | undefined;
}

export async function call(bff: Pick<Bff, "handler">, event: APIGatewayProxyEventV2): Promise<CallResult> {
  const response: APIGatewayProxyStructuredResultV2 = await bff.handler(event, lambdaContext);
  const body = JSON.parse(response.body ?? "{}") as { result?: { data?: unknown }; error?: { data?: CallResult["error"] } };
  return { status: response.statusCode ?? 0, data: body.result?.data, error: body.error?.data };
}
