import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AUTH_REASON, AuthError } from "../auth/errors";
import { type Principal, qaPrincipal } from "../auth/principal";
import { FENCE_LIMITS, fencedIdsOf, operationOfChildId } from "../auth/scope";
import { createTestIssuer, seedBrokers, testContextDeps } from "../auth/testing";
import type { MemoryStores } from "../connector/index";
import { hashOf, importerFixture, memoryStores, operationFixture, seedDemoSlice, supplierFixture } from "../connector/testing";
import type { ContextDeps } from "./deps";
import { createHandler } from "./handler";
import { createConsoleCaller } from "./index";
import { createCallerFactory, createContextFactory, firmProcedure, recentLoginProcedure, router, serverContext } from "./trpc";

const NOW = new Date("2026-10-15T13:00:00.000Z");
const PABLO_SUB = "0b7f0e2e-0000-4000-8000-000000000004";
const DIEGO_SUB = "0b7f0e2e-0000-4000-8000-000000000001";
const issuer = createTestIssuer({ now: () => NOW });

let ran: string[] = [];
const testRouter = router({
  operations: router({
    get: firmProcedure.input(z.object({ operationId: z.string() })).query(({ ctx, input }) => ctx.deps.connector.operations.getOperation(input.operationId)),
    approve: recentLoginProcedure.input(z.object({ operationId: z.string() })).mutation(() => "approved"),
  }),
  anything: firmProcedure.input(z.unknown()).query(() => {
    ran.push("anything");
    return "ran";
  }),
  byRef: firmProcedure.input(z.object({ ref: z.string() })).query(async ({ ctx, input }) => {
    await ctx.firmScope.assertId(input.ref);
    return "ran";
  }),
});
const callerOf = createCallerFactory(testRouter);

async function norteWorld(stores: MemoryStores): Promise<void> {
  await seedDemoSlice(stores);
  const { parties, operations } = stores.connector;
  const norte = { firmId: "firm-norte", clockId: "GLOBAL#firm-norte" };
  await parties.createImporter(importerFixture({ ...norte, importerId: "imp-altiplano", name: "Altiplano Maquinarias SRL", contactName: "Rocío Vera", contactFirstName: "Rocío", phoneE164: "+5491155500201", phoneHash: hashOf("+5491155500201") }));
  await parties.createSupplier(supplierFixture({ ...norte, supplierId: "sup-n-qingdao" }));
  const operation = operationFixture({ ...norte, operationNumber: "5501", importerId: "imp-altiplano", supplierId: "sup-n-qingdao", threadTag: "n5p8r2" });
  await operations.createOperation({ ...operation, threadClaimHash: hashOf(operation.threadAddress) });
  await seedBrokers(stores, [
    { firmId: "firm-delta", brokerId: "brk-delta-diego", role: "BROKER", sub: DIEGO_SUB },
    { firmId: "firm-norte", brokerId: "brk-norte-pablo", role: "BROKER", sub: PABLO_SUB },
  ]);
}

const pablo: Principal = { sub: PABLO_SUB, username: "b7f0e2e4", firmId: "firm-norte", role: "BROKER", groups: ["BROKER"], isGuest: false, authTime: NOW.getTime() / 1000 };
const guest: Principal = { sub: "0b7f0e2e-0000-4000-8000-000000000003", username: "guest-01", firmId: "firm-guest-01", role: "GUEST", groups: ["GUEST"], isGuest: true, authTime: NOW.getTime() / 1000 };

async function refusalOf(call: Promise<unknown>): Promise<{ code: string; reason: string }> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TRPCError) return { code: error.code, reason: error.cause instanceof AuthError ? error.cause.reason : String(error.cause?.name) };
    throw error;
  }
  throw new Error("expected a refusal");
}

function functionUrlEvent(path: string, input: unknown, token: string): APIGatewayProxyEventV2 {
  const rawQueryString = `input=${encodeURIComponent(JSON.stringify(input))}`;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString,
    headers: { authorization: `Bearer ${token}`, "x-correlation-id": "console-isolation-01" },
    isBase64Encoded: false,
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "bff-url.lambda-url.us-east-1.on.aws",
      domainPrefix: "bff-url",
      http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "vitest" },
      requestId: "req-isolation-0001",
      routeKey: "$default",
      stage: "$default",
      time: "15/Oct/2026:13:00:00 +0000",
      timeEpoch: NOW.getTime(),
    },
  };
}

const lambdaContext = { awsRequestId: "lambda-req-0001", getRemainingTimeInMillis: () => 10_000 } as unknown as LambdaContext;

describe("[FL-082] firm isolation of the console", () => {
  let stores: MemoryStores;
  let deps: ContextDeps;
  let lines: string[];

  beforeEach(async () => {
    ran = [];
    lines = [];
    stores = memoryStores();
    await norteWorld(stores);
    deps = testContextDeps({ verifier: issuer.verifier(), stores, now: () => NOW, lines });
  });

  const as = (principal: Principal) => callerOf(serverContext({ principal, deps }));
  const denials = (firmId: string) => stores.connector.audit.listByDecision(firmId, "DENY");

  it("[FL-082] answers 403 with no data to a broker of firm-norte asking for an operation of firm-delta, and logs DENY CROSS_FIRM in firm-norte", async () => {
    const handler = createHandler(testRouter, createContextFactory(() => deps));
    const token = issuer.idToken({ sub: PABLO_SUB, "custom:firmId": "firm-norte" });
    const response = await handler(functionUrlEvent("/api/operations.get", { operationId: "op-4471" }, token), lambdaContext);

    expect(response.statusCode).toBe(403);
    const body = z.looseObject({ error: z.looseObject({ data: z.looseObject({ reason: z.string(), correlationId: z.string() }) }) }).parse(JSON.parse(response.body ?? "{}"));
    expect(body.error.data).toMatchObject({ reason: AUTH_REASON.CROSS_FIRM, correlationId: "console-isolation-01" });
    for (const leaked of ["Norpampa", "4471", "Austral Aurora", "firm-delta"]) expect(response.body).not.toContain(leaked);

    const [decision, ...others] = await denials("firm-norte");
    expect(others).toEqual([]);
    expect(decision).toMatchObject({
      decision: "DENY",
      action: "CROSS_FIRM",
      actor: "BROKER:brk-norte-pablo",
      firmId: "firm-norte",
      correlationId: "console-isolation-01",
      detail: { procedure: "operations.get", targetKind: "operation", targetId: "op-4471" },
    });
    // Nothing reaches firm-delta: neither its log nor the timeline of its operation.
    expect(await denials("firm-delta")).toEqual([]);
    expect(await stores.connector.audit.listByOperation("op-4471")).toEqual([]);
  });

  it("[FL-082] lets the same broker read its own firm's operation", async () => {
    const handler = createHandler(testRouter, createContextFactory(() => deps));
    const token = issuer.idToken({ sub: PABLO_SUB, "custom:firmId": "firm-norte" });
    const response = await handler(functionUrlEvent("/api/operations.get", { operationId: "op-5501" }, token), lambdaContext);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("op-5501");
    expect(await denials("firm-norte")).toEqual([]);
  });

  it.each([
    ["an importer", { importerId: "imp-norpampa" }],
    ["a supplier", { supplierId: "sup-qingdao" }],
    ["a document version", { docVersionId: "dv-4471-PL-1" }],
    ["an observation", { observationId: "obs-4471-PL-GROSS_WEIGHT_MISMATCH" }],
    ["the world clock", { clockId: "GLOBAL#firm-delta" }],
    ["the firm itself", { firmId: "firm-delta" }],
    ["a listed id", { operationIds: ["op-5501", "op-4471"] }],
    ["a nested id", { filter: { rows: [{ targetOperationId: "op-4471" }] } }],
    ["an id under a field not named like one", { target: "imp-norpampa" }],
    ["an id under an oddly cased field", { operationID: "op-4471" }],
    ["an id used as a key", { byOperation: { "op-4471": true } }],
  ])("[FL-082] refuses %s of another firm before the procedure runs", async (_label, input) => {
    expect(await refusalOf(as(pablo).anything(input))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_FIRM });
    expect(ran).toEqual([]);
    expect(await denials("firm-norte")).toHaveLength(1);
  });

  it("[FL-082] passes the firm's own ids, ids that do not exist and text that only mentions an id", async () => {
    const own = { importerId: "imp-altiplano", supplierId: "sup-n-qingdao", clockId: "GLOBAL#firm-norte", firmId: "firm-norte", docVersionId: "dv-5501-CI-1" };
    expect(await as(pablo).anything(own)).toBe("ran");
    expect(await as(pablo).anything({ operationId: "op-4499", note: "about op-4471" })).toBe("ran");
    expect(await refusalOf(as(pablo).operations.get({ operationId: "op-4499" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await denials("firm-norte")).toEqual([]);
  });

  it.each([
    ["51 ids, the last one of another firm", { operationIds: [...Array.from({ length: 50 }, (_, index) => `op-${9000 + index}`), "op-4471"] }],
    ["an id nested past the depth bound", { a: { b: { c: { d: { e: { f: { g: { operationId: "op-4471" } } } } } } } }],
    ["an input with too many values", { notes: Array.from({ length: FENCE_LIMITS.nodes }, () => "x") }],
  ])("[FL-082] refuses %s whole instead of fencing it in part", async (_label, input) => {
    expect(await refusalOf(as(pablo).anything(input))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.INPUT_TOO_LARGE });
    expect(ran).toEqual([]);
    expect(await denials("firm-norte")).toMatchObject([{ decision: "DENY", action: "INPUT_TOO_LARGE", actor: "BROKER:brk-norte-pablo" }]);
  });

  it("[FL-082] fences ids a procedure reaches by other means through ctx.firmScope", async () => {
    expect(await as(pablo).byRef({ ref: "op-5501" })).toBe("ran");
    expect(await refusalOf(as(pablo).byRef({ ref: "op-4471" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_FIRM });
  });

  it("[FL-082] keeps a guest inside its own guest world", async () => {
    expect(await as(guest).anything({ clockId: "GUEST#firm-guest-01" })).toBe("ran");
    expect(await refusalOf(as(guest).anything({ clockId: "GUEST#firm-guest-02" }))).toMatchObject({ reason: AUTH_REASON.CROSS_FIRM });
    expect(await refusalOf(as(guest).operations.get({ operationId: "op-4471" }))).toMatchObject({ reason: AUTH_REASON.CROSS_FIRM });
    const [decision] = await denials("firm-guest-01");
    expect(decision).toMatchObject({ actor: "SYSTEM", detail: { sub: guest.sub, role: "GUEST" } });
  });

  it("[FL-082] runs the same fence for the QaDriver's createCaller with a principal built on the server (SC-20/3)", async () => {
    const qa = callerOf(serverContext({ principal: qaPrincipal({ role: "BROKER", now: NOW }), deps, correlationId: "qa-run-812-sc20-3" }));
    expect(await refusalOf(qa.operations.get({ operationId: "op-4471" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_FIRM });
    expect(await denials("firm-qa")).toMatchObject([{ action: "CROSS_FIRM", actor: "BROKER:brk-qa-runner", correlationId: "qa-run-812-sc20-3" }]);
    expect(await qa.anything({ clockId: "qa-812-1-sc20" })).toBe("ran");
    expect(await qa.anything({ clockId: "GLOBAL#firm-qa" })).toBe("ran");
    expect(await refusalOf(qa.anything({ clockId: "sim-batch-01" }))).toMatchObject({ reason: AUTH_REASON.CROSS_FIRM });
    const consoleCaller = createConsoleCaller(serverContext({ principal: qaPrincipal({ role: "ANALYST", now: NOW }), deps }));
    expect(await consoleCaller.health()).toEqual({ ok: true, service: "bff", checks: {} });
  });

  it("refuses an old sign-in on recent-login procedures, also for a server-built principal", async () => {
    const stale = qaPrincipal({ role: "BROKER", now: NOW, authTime: new Date(NOW.getTime() - 16 * 60_000) });
    expect(await refusalOf(as(stale).operations.approve({ operationId: "op-4499" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.LOGIN_NOT_RECENT });
    expect(await as(qaPrincipal({ role: "BROKER", now: NOW })).operations.approve({ operationId: "op-4499" })).toBe("approved");
  });

  it("refuses and logs DENY ROLE_NOT_ALLOWED when an analyst calls a broker procedure", async () => {
    const analyst = qaPrincipal({ role: "ANALYST", now: NOW });
    expect(await refusalOf(as(analyst).operations.approve({ operationId: "op-4499" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.ROLE_NOT_ALLOWED });
    expect(await denials("firm-qa")).toMatchObject([{ action: "ROLE_NOT_ALLOWED", actor: "BROKER:brk-qa-analyst", detail: { procedure: "operations.approve", role: "ANALYST" } }]);
  });

  it("still refuses with 403 when the audit log cannot be written", async () => {
    const broken: ContextDeps = { ...deps, connector: { ...deps.connector, audit: { ...deps.connector.audit, record: () => Promise.reject(new Error("table unavailable")) } } };
    const caller = callerOf(serverContext({ principal: pablo, deps: broken }));
    expect(await refusalOf(caller.operations.get({ operationId: "op-4471" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_FIRM });
    expect(lines.some((line) => line.includes("console.audit.failed"))).toBe(true);
  });
});

describe("firm fence: which values are ids", () => {
  it("collects every fenced id whatever its field, once each, and derives a child's operation", () => {
    const walk = fencedIdsOf({ operationId: "op-4471", text: "firm-norte", nested: { ids: ["imp-norpampa", "op-4471"], brokerId: "brk-delta-diego", "sup-qingdao": 1 }, clockId: "qa-812-1-sc20", note: "see op-5501" });
    expect(walk).toEqual({
      ok: true,
      ids: [
        { kind: "operation", id: "op-4471" },
        { kind: "firm", id: "firm-norte" },
        { kind: "importer", id: "imp-norpampa" },
        { kind: "supplier", id: "sup-qingdao" },
        { kind: "clock", id: "qa-812-1-sc20" },
      ],
    });
    expect(operationOfChildId("dv-4471-g03-PL-2")).toBe("op-4471-g03");
    expect(operationOfChildId("obs-5501-CO-SIGNATURE_MISSING")).toBe("op-5501");
    expect(operationOfChildId("op-4471")).toBeUndefined();
  });

  it("fails closed past its bounds instead of returning the ids it collected so far", () => {
    const ids = (count: number) => ({ operationIds: Array.from({ length: count }, (_, index) => `op-${4000 + index}`) });
    expect(fencedIdsOf(ids(FENCE_LIMITS.ids))).toMatchObject({ ok: true, ids: { length: FENCE_LIMITS.ids } });
    expect(fencedIdsOf(ids(FENCE_LIMITS.ids + 1))).toEqual({ ok: false, limit: "ids" });
    const nest = (levels: number) => {
      let deep: Record<string, unknown> = { operationId: "op-4471" };
      for (let level = 0; level < levels; level += 1) deep = { child: deep };
      return deep;
    };
    expect(fencedIdsOf(nest(FENCE_LIMITS.depth))).toMatchObject({ ok: true, ids: [{ id: "op-4471" }] });
    expect(fencedIdsOf(nest(FENCE_LIMITS.depth + 1))).toEqual({ ok: false, limit: "depth" });
    expect(fencedIdsOf({ values: Array.from({ length: FENCE_LIMITS.nodes }, () => 1) })).toEqual({ ok: false, limit: "nodes" });
  });
});
