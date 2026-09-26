import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestIssuer, testContextDeps } from "../auth/testing";
import { memoryStores } from "../connector/testing";
import type { SignableRequest } from "../reader/signer";
import { createHandler } from "./handler";
import { type HealthCheck, HealthCheckError, cachedHealthCheck, functionUrlHealthCheck, healthReport } from "./health";
import { appRouter } from "./index";
import { createContextFactory } from "./trpc";
import { createLogger } from "../lib/log";

const ENDPOINT = "https://abc123platform.lambda-url.us-east-1.on.aws/";

function probeEvent(headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/api/health",
    rawQueryString: "",
    headers,
    isBase64Encoded: false,
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "bff-url.lambda-url.us-east-1.on.aws",
      domainPrefix: "bff-url",
      http: { method: "GET", path: "/api/health", protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "smoke" },
      requestId: "req-health-0001",
      routeKey: "$default",
      stage: "$default",
      time: "15/Oct/2026:13:00:00 +0000",
      timeEpoch: 1792069200000,
    },
  };
}

const lambdaContext = { awsRequestId: "lambda-req-0001", getRemainingTimeInMillis: () => 10_000 } as unknown as LambdaContext;

const Probe = z.object({ result: z.object({ data: z.object({ ok: z.boolean(), service: z.literal("bff"), checks: z.record(z.string(), z.string()) }) }) });

function check(name: string, outcome: () => Promise<void>): HealthCheck {
  return { name, run: outcome };
}

async function probe(checks: readonly HealthCheck[], headers?: Record<string, string>) {
  const deps = testContextDeps({ verifier: createTestIssuer().verifier(), stores: memoryStores(), health: checks });
  const response = await createHandler(appRouter, createContextFactory(() => deps))(probeEvent(headers), lambdaContext);
  return { status: response.statusCode, contentType: response.headers?.["content-type"], data: Probe.parse(JSON.parse(response.body ?? "{}")).result.data };
}

describe("GET /api/health", () => {
  it("answers without a principal, as the interim smoke expects (`result.data.ok === true`)", async () => {
    const response = await probe([check("platform", () => Promise.resolve())], { authorization: "Bearer not-a-token" });
    expect(response.status).toBe(200);
    expect(String(response.contentType)).toContain("application/json");
    expect(response.data).toEqual({ ok: true, service: "bff", checks: { platform: "ok" } });
  });

  it("reports a mock that does not answer to the BFF's role, without the error's details", async () => {
    const response = await probe([check("platform", () => Promise.reject(new HealthCheckError(403, false)))]);
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: false, service: "bff", checks: { platform: "unavailable" } });
  });

  it("logs a failing check by class and message only", async () => {
    const lines: string[] = [];
    const report = await healthReport([check("platform", () => Promise.reject(new Error("socket hang up")))], createLogger({ sink: (line) => void lines.push(line) }));
    expect(report.ok).toBe(false);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ level: "warn", message: "console.health.check_failed", check: "platform", errorName: "Error", errorMessage: "socket hang up" }),
    ]);
  });
});

describe("Function URL health check (PlatformMock /v1/health with the BFF's role)", () => {
  interface Recorded {
    readonly url: string;
    readonly headers: Record<string, string>;
  }

  function fakeFetch(answers: Array<Response | Error>, recorded: Recorded[]): typeof fetch {
    return async (input, init) => {
      recorded.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      const next = answers.shift();
      if (next === undefined || next instanceof Error) throw next ?? new Error("no answer left");
      return next;
    };
  }

  const sign = async (request: SignableRequest) => ({ ...request.headers, authorization: `AWS4-HMAC-SHA256 signed-for-${request.url.pathname}` });
  const ok = () => new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  const noSleep = () => Promise.resolve();

  it("signs a GET of /v1/health on the linked Function URL and accepts `{ status: \"ok\" }`", async () => {
    const recorded: Recorded[] = [];
    await functionUrlHealthCheck({ name: "platform", endpoint: () => ENDPOINT, sign, fetch: fakeFetch([ok()], recorded) }).run();
    expect(recorded).toEqual([{ url: `${ENDPOINT}v1/health`, headers: { accept: "application/json", authorization: "AWS4-HMAC-SHA256 signed-for-/v1/health" } }]);
  });

  it("retries a 5xx or a network failure once with backoff, and never a 403", async () => {
    const recorded: Recorded[] = [];
    await functionUrlHealthCheck({ name: "platform", endpoint: () => ENDPOINT, sign, sleep: noSleep, fetch: fakeFetch([new Response("", { status: 503 }), ok()], recorded) }).run();
    expect(recorded).toHaveLength(2);

    const network = functionUrlHealthCheck({ name: "platform", endpoint: () => ENDPOINT, sign, sleep: noSleep, fetch: fakeFetch([new TypeError("fetch failed"), ok()], []) });
    await expect(network.run()).resolves.toBeUndefined();

    const forbidden: Recorded[] = [];
    const denied = functionUrlHealthCheck({ name: "platform", endpoint: () => ENDPOINT, sign, sleep: noSleep, fetch: fakeFetch([new Response("", { status: 403 }), ok()], forbidden) });
    await expect(denied.run()).rejects.toMatchObject({ name: "HealthCheckError", status: 403 });
    expect(forbidden).toHaveLength(1);
  });

  it("gives up when the mock does not answer within its deadline", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error)));
    const slow = functionUrlHealthCheck({ name: "platform", endpoint: () => ENDPOINT, sign, sleep: noSleep, timeoutMs: 20, fetch: hanging });
    await expect(slow.run()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("refuses an unexpected body and a missing link", async () => {
    const wrong = new Response(JSON.stringify({ status: "degraded" }), { status: 200 });
    await expect(functionUrlHealthCheck({ name: "platform", endpoint: () => ENDPOINT, sign, fetch: fakeFetch([wrong], []) }).run()).rejects.toThrow();
    const unlinked = functionUrlHealthCheck({
      name: "platform",
      endpoint: () => {
        throw new Error('resource "PlatformMock" is not linked to this function');
      },
      sign,
      fetch: fakeFetch([ok()], []),
    });
    await expect(unlinked.run()).rejects.toThrow("not linked");
  });

  it("keeps the last outcome for its TTL, so a burst of public probes costs one call", async () => {
    let calls = 0;
    let now = Date.parse("2026-10-15T13:00:00Z");
    const cached = cachedHealthCheck(
      check("platform", async () => {
        calls += 1;
        if (calls === 1) throw new HealthCheckError(503, true);
      }),
      { ttlMs: 30_000, now: () => new Date(now) },
    );
    await Promise.all([cached.run(), cached.run(), cached.run()].map((run) => run.catch(() => "failed")));
    expect(calls).toBe(1);
    await expect(cached.run()).rejects.toMatchObject({ status: 503 });
    now += 30_000;
    await expect(cached.run()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
