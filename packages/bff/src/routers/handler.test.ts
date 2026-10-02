import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AUTH_REASON } from "../auth/errors";
import { createTestIssuer, seedBrokers, testContextDeps } from "../auth/testing";
import { memoryStores } from "../connector/testing";
import { edgeHeaders, testEdgeGuard } from "../signup/testing";
import { createHandler, stripApiPrefix } from "./handler";
import { appRouter } from "./index";
import { brokerProcedure, createContextFactory, firmProcedure, recentLoginProcedure, router } from "./trpc";

const issuer = createTestIssuer();
const lines: string[] = [];
const BROKER_SUB = "7f1c9d2e-0000-4000-8000-000000000001";
const INACTIVE_SUB = "7f1c9d2e-0000-4000-8000-00000000dead";
// Users whose `sub` has no broker row: their role is the token's.
const UNBOUND_SUB = "7f1c9d2e-0000-4000-8000-00000000beef";
// A guest is never unbound: its world's broker row has to exist (ADR-0015 §4).
const GUEST_SUB = "7f1c9d2e-0000-4000-8000-00000000c0de";

const stores = memoryStores();
await seedBrokers(stores, [
  { firmId: "firm-delta", brokerId: "brk-delta-diego", role: "BROKER", sub: BROKER_SUB },
  { firmId: "firm-delta", brokerId: "brk-delta-gone", role: "BROKER", sub: INACTIVE_SUB, active: false },
  { firmId: "firm-guest-01", brokerId: "brk-guest-01", role: "GUEST", sub: GUEST_SUB },
]);
const deps = testContextDeps({ verifier: issuer.verifier(), stores, lines });

const testRouter = router({
  session: router({
    whoami: firmProcedure.query(({ ctx }) => ({ firmId: ctx.principal.firmId, role: ctx.principal.role, brokerId: ctx.principal.brokerId })),
    brokerOnly: brokerProcedure.query(() => "ok"),
    approve: recentLoginProcedure.mutation(() => "approved"),
    boom: firmProcedure.query(() => {
      throw new Error("connection string leaked here");
    }),
  }),
});

const ResponseBody = z.looseObject({
  result: z.object({ data: z.unknown() }).optional(),
  error: z.looseObject({ message: z.string(), data: z.looseObject({ code: z.string(), reason: z.string().nullable(), correlationId: z.string().nullable() }) }).optional(),
});

function functionUrlEvent(rawPath: string, headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers: { ...edgeHeaders(), ...headers },
    isBase64Encoded: false,
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "bff-url.lambda-url.us-east-1.on.aws",
      domainPrefix: "bff-url",
      http: { method: "GET", path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "vitest" },
      requestId: "req-handler-0001",
      routeKey: "$default",
      stage: "$default",
      time: "18/Sep/2026:15:00:00 +0000",
      timeEpoch: 1789743600000,
    },
  };
}

const lambdaContext: LambdaContext = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "bff-test",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:bff-test",
  memoryLimitInMB: "512",
  awsRequestId: "lambda-req-0001",
  logGroupName: "/aws/lambda/bff-test",
  logStreamName: "2026/09/18/[$LATEST]test",
  getRemainingTimeInMillis: () => 10_000,
  done: () => undefined,
  fail: () => undefined,
  succeed: () => undefined,
};

const handler = createHandler(testRouter, createContextFactory(() => deps), testEdgeGuard);

async function call(rawPath: string, headers?: Record<string, string>) {
  const response = await handler(functionUrlEvent(rawPath, headers), lambdaContext);
  return { status: response.statusCode, headers: response.headers ?? {}, body: ResponseBody.parse(JSON.parse(response.body ?? "{}")) };
}

describe("BFF Lambda handler", () => {
  it("serves /api/<procedure> behind the Router and /<procedure> on the Function URL", async () => {
    const authorization = `Bearer ${issuer.idToken()}`;
    for (const path of ["/api/session.whoami", "/session.whoami"]) {
      const response = await call(path, { "x-legajo-auth": authorization });
      expect(response.status).toBe(200);
      expect(response.body.result?.data).toEqual({ firmId: "firm-delta", role: "BROKER", brokerId: "brk-delta-diego" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("answers HTTP 401 with the reason and the correlation id when the token has no firm", async () => {
    const response = await call("/api/session.whoami", { "x-legajo-auth": `Bearer ${issuer.idToken({ "custom:firmId": undefined })}` });
    expect(response.status).toBe(401);
    expect(response.body.error?.data).toMatchObject({ code: "UNAUTHORIZED", reason: AUTH_REASON.PRINCIPAL_INCOMPLETE, correlationId: "req-handler-0001" });
  });

  it("answers HTTP 401 without a token and takes a well-formed x-correlation-id", async () => {
    const response = await call("/api/session.whoami", { "x-correlation-id": "console-7f1c9d2e" });
    expect(response.status).toBe(401);
    expect(response.body.error?.data).toMatchObject({ reason: AUTH_REASON.TOKEN_MISSING, correlationId: "console-7f1c9d2e" });
  });

  it("refuses an inactive broker, an analyst on broker procedures and an old sign-in on approvals", async () => {
    const inactive = await call("/api/session.whoami", { "x-legajo-auth": `Bearer ${issuer.idToken({ sub: INACTIVE_SUB })}` });
    expect(inactive.status).toBe(403);
    expect(inactive.body.error?.data).toMatchObject({ reason: AUTH_REASON.BROKER_INACTIVE });
    const analyst = await call("/api/session.brokerOnly", { "x-legajo-auth": `Bearer ${issuer.idToken({ sub: UNBOUND_SUB, "custom:role": "ANALYST", "cognito:groups": ["ANALYST"] })}` });
    expect(analyst.status).toBe(403);
    expect(analyst.body.error?.data).toMatchObject({ reason: AUTH_REASON.ROLE_NOT_ALLOWED });
    const guest = await call("/api/session.brokerOnly", {
      "x-legajo-auth": `Bearer ${issuer.idToken({ sub: GUEST_SUB, "custom:firmId": "firm-guest-01", "custom:role": "GUEST", "cognito:groups": ["GUEST"] })}`,
    });
    expect(guest.status).toBe(200);
    const old = Math.floor(Date.now() / 1000) - 16 * 60;
    const stale = await handler(
      { ...functionUrlEvent("/api/session.approve", { "x-legajo-auth": `Bearer ${issuer.idToken({ auth_time: old })}`, "content-type": "application/json" }), body: "{}", requestContext: { ...functionUrlEvent("/").requestContext, http: { ...functionUrlEvent("/").requestContext.http, method: "POST" } } },
      lambdaContext,
    );
    expect(stale.statusCode).toBe(403);
    expect(ResponseBody.parse(JSON.parse(stale.body ?? "{}")).error?.data).toMatchObject({ reason: AUTH_REASON.LOGIN_NOT_RECENT });
  });

  it("never sends a stack trace and logs unexpected failures with the correlation id", async () => {
    lines.length = 0;
    const response = await handler(functionUrlEvent("/api/session.boom", { "x-legajo-auth": `Bearer ${issuer.idToken()}` }), lambdaContext);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("stack");
    expect(lines.map((line) => z.looseObject({ message: z.string(), correlationId: z.string() }).parse(JSON.parse(line)))).toContainEqual(
      expect.objectContaining({ message: "console.procedure.failed", correlationId: "req-handler-0001", path: "session.boom" }),
    );
  });

  it("the console router answers the public health probe and 404 for an unknown procedure", async () => {
    const bff = createHandler(appRouter, createContextFactory(() => deps), testEdgeGuard);
    const health = await bff(functionUrlEvent("/api/health"), lambdaContext);
    expect(health.statusCode).toBe(200);
    expect(ResponseBody.parse(JSON.parse(health.body ?? "{}")).result?.data).toEqual({ ok: true, service: "bff", checks: {} });
    const unknown = await bff(functionUrlEvent("/api/nothing.here"), lambdaContext);
    expect(unknown.statusCode).toBe(404);
  });
});

describe("stripApiPrefix", () => {
  it.each([
    ["/api/operations.list", "/operations.list"],
    ["/api/operations.list,operations.get", "/operations.list,operations.get"],
    ["/api", "/"],
    ["/operations.list", "/operations.list"],
    ["/apiary.list", "/apiary.list"],
  ])("%s → %s", (rawPath, expected) => {
    const event = stripApiPrefix(functionUrlEvent(rawPath));
    expect(event.rawPath).toBe(expected);
    expect(event.requestContext.http.path).toBe(expected);
  });
});
