// The access line of the public HTTP entries (lib/access-log.ts): the eight fields, written when the
// request ends, also when the edge check refuses it early or the handler throws; route and user agent
// sanitized; never a query string, a body, the id token of `X-Legajo-Auth`, the upload link's token,
// an email or a phone; `sub` only once the id token was verified.
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryStores } from "../connector/testing";
import { testAccessDeps } from "../signup/testing";
import { bffFor, lambdaContext, trpcEvent } from "../signup/testing-http";
import { ACCESS_MESSAGE, ROUTE_MAX, USER_AGENT_MAX, pathOf, publicWebRoute, sanitize, withAccessLog } from "./access-log";
import { createLogger } from "./log";

const NOW = new Date("2026-10-14T13:30:00.000Z");
let lines: Record<string, unknown>[];

beforeEach(() => {
  lines = [];
});

const logger = () => createLogger({ level: "info", bindings: { service: "bff" }, sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) });
const accessLines = () => lines.filter((line) => line.message === ACCESS_MESSAGE);

function wrappedBff() {
  const stores = memoryStores();
  const access = testAccessDeps(stores, { now: () => NOW });
  const bff = bffFor(stores, access);
  let clock = 1_000;
  const handler = withAccessLog(bff.handler, { service: "bff", route: pathOf, logger, now: () => (clock += 7) });
  return { bff, handler };
}

describe("[FL-138] the access line of Bff", () => {
  it("has the eight fields, with the viewer's address of CloudFront and the verified sub", async () => {
    const { bff, handler } = wrappedBff();
    const token = bff.issuer.idToken({ sub: "5a1d0c3e-0000-4000-8000-0000000000a1", "cognito:username": "b0000aaaa", "custom:firmId": "firm-delta", "cognito:groups": ["BROKER"] });
    const event = trpcEvent("GET", "/api/account.preferences", { input: {}, headers: { "x-legajo-auth": `Bearer ${token}`, "user-agent": "Mozilla/5.0 (Test)", "x-forwarded-for": "10.9.9.9" } });
    await handler(event, lambdaContext);
    expect(accessLines()).toEqual([
      expect.objectContaining({ level: "info", service: "bff", message: "acceso", route: "/api/account.preferences", method: "GET", status: 200, ip: "198.51.100.10", userAgent: "Mozilla/5.0 (Test)", sub: "5a1d0c3e-0000-4000-8000-0000000000a1", ms: 7 }),
    ]);
  });

  it("logs a request the edge check refuses before routing, without sub", async () => {
    const { handler } = wrappedBff();
    const refused = await handler(trpcEvent("POST", "/api/operations.list", { edge: { "cloudfront-viewer-address": "203.0.113.7:1234" } }), lambdaContext);
    expect(refused.statusCode).toBe(403);
    expect(accessLines()).toEqual([expect.objectContaining({ route: "/api/operations.list", method: "POST", status: 403, ip: "203.0.113.7" })]);
    expect(accessLines()[0]).not.toHaveProperty("sub");
  });

  it("logs an unknown procedure and a request without a valid token, with their status", async () => {
    const { handler } = wrappedBff();
    await handler(trpcEvent("GET", "/api/nothing.here", { input: {} }), lambdaContext);
    await handler(trpcEvent("GET", "/api/account.session", { input: {}, headers: { "x-legajo-auth": "Bearer not-a-token" } }), lambdaContext);
    expect(accessLines().map((line) => [line.route, line.status])).toEqual([
      ["/api/nothing.here", 404],
      ["/api/account.session", 401],
    ]);
  });

  it("never carries the query string, the body, the id token, an email or a phone", async () => {
    const { bff, handler } = wrappedBff();
    const token = bff.issuer.idToken({ sub: "5a1d0c3e-0000-4000-8000-0000000000a2", "cognito:username": "b0000bbbb", "custom:firmId": "firm-delta", "cognito:groups": ["BROKER"] });
    const input = { email: "ana.gomez@despachos-del-sur.com.ar", phone: "+5491155550101" };
    await handler(trpcEvent("POST", "/api/account.sendPhoneCode", { input, query: "batch=1&email=ana.gomez%40despachos-del-sur.com.ar", headers: { "x-legajo-auth": `Bearer ${token}` } }), lambdaContext);
    const written = JSON.stringify(accessLines());
    for (const secret of [token, "ana.gomez", "+5491155550101", "5491155550101", "batch=1", "Bearer"]) expect(written).not.toContain(secret);
    expect(accessLines()[0]).toMatchObject({ route: "/api/account.sendPhoneCode" });
  });
});

describe("[FL-138] the wrapper itself", () => {
  const bare = (rawPath: string, headers: Record<string, string> = {}): APIGatewayProxyEventV2 =>
    ({ rawPath, rawQueryString: "", headers: { "cloudfront-viewer-address": "[2001:db8::1]:443", ...headers }, requestContext: { http: { method: "post" } } }) as unknown as APIGatewayProxyEventV2;

  it("logs 500 and rethrows when the handler throws, and never changes an answer", async () => {
    const failing = withAccessLog(async () => Promise.reject(new Error("boom")), { service: "bff", route: pathOf, logger });
    await expect(failing(bare("/api/x"))).rejects.toThrow("boom");
    expect(accessLines()).toEqual([expect.objectContaining({ route: "/api/x", method: "POST", status: 500, ip: "2001:db8::1" })]);
    const answered = withAccessLog(async () => ({ statusCode: 204, body: "" }), { service: "bff", route: pathOf, logger });
    expect(await answered(bare("/api/y"))).toEqual({ statusCode: 204, body: "" });
  });

  it("strips control characters and line breaks and truncates route and user agent", async () => {
    const handler = withAccessLog(async () => ({ statusCode: 200 }), { service: "bff", route: pathOf, logger });
    await handler(bare(`/api/a%0A{"message":"acceso"}${"x".repeat(300)}`, { "user-agent": `bot\r\n\u2028${"y".repeat(200)}` }));
    const [line] = accessLines();
    expect(String(line?.route)).not.toMatch(/[\n\r\u2028]/);
    expect(String(line?.route).length).toBeLessThanOrEqual(ROUTE_MAX);
    expect(String(line?.userAgent)).toBe(`bot${"y".repeat(USER_AGENT_MAX - 3)}`);
    expect(sanitize("a\u0000b\u009fc\u2029d", 10)).toBe("abcd");
  });

  it("cuts the upload link's token out of PublicWeb's route", async () => {
    const handler = withAccessLog(async () => ({ statusCode: 410 }), { service: "public-web", route: publicWebRoute, logger });
    await handler(bare("/u/tok_abcdefghijklmnopqrstuvwxyz012345/presign"));
    await handler(bare("/u/tok_abcdefghijklmnopqrstuvwxyz012345"));
    expect(accessLines().map((line) => line.route)).toEqual(["/u/:token/presign", "/u/:token"]);
    expect(JSON.stringify(lines)).not.toContain("tok_abcdefghijklmnopqrstuvwxyz012345");
  });
});
