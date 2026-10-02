// FL-113 (c): every route of `Bff` and of `PublicWeb` refuses a request without the distribution's
// `X-Origin-Verify`, or with another value, with 403 as its first step: before the token is verified,
// before routing, whatever the procedure and whether a token comes or not (ADR-0015 §3.1).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { publicEvent, publicWebWorld } from "../public-web/testing";
import { TEST_VIEWER, type TestAccess, testAccessDeps } from "../signup/testing";
import { validForm } from "../signup/testing-flows";
import { type Bff, bffFor, call, trpcEvent } from "../signup/testing-http";

let stores: MemoryStores;
let access: TestAccess;
let bff: Bff;

beforeEach(() => {
  stores = memoryStores();
  access = testAccessDeps(stores);
  bff = bffFor(stores, access);
});

const WRONG_ORIGINS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["without the header", { "cloudfront-viewer-address": TEST_VIEWER }],
  ["with another value", { "x-origin-verify": "not-the-distribution", "cloudfront-viewer-address": TEST_VIEWER }],
  ["with an empty value", { "x-origin-verify": "", "cloudfront-viewer-address": TEST_VIEWER }],
];

describe("[FL-113] X-Origin-Verify is the first step of every route of Bff", () => {
  it.each(WRONG_ORIGINS)("%s: 403 for any procedure, with or without a token, and the token is never verified", async (_label, edge) => {
    const verify = vi.spyOn(bff.deps.verifier, "verify");
    const token = `Bearer ${bff.issuer.idToken()}`;
    for (const [method, path, input] of [
      ["GET", "/api/health", undefined],
      ["POST", "/api/signup.start", validForm(access)],
      ["GET", "/api/operations.list", {}],
      ["GET", "/api/account.session", undefined],
    ] as const) {
      for (const headers of [{}, { "x-legajo-auth": token }] as Array<Record<string, string>>) {
        const result = await call(bff, trpcEvent(method, path, { input, edge, headers }));
        expect(result.status, `${method} ${path}`).toBe(403);
        expect(result.error).toMatchObject({ reason: "ORIGIN_NOT_VERIFIED" });
      }
    }
    expect(verify).not.toHaveBeenCalled();
    expect(access.invoker.invoked).toEqual([]);
  });

  it("with the distribution's value the request goes on", async () => {
    expect((await call(bff, trpcEvent("GET", "/api/health"))).status).toBe(200);
  });
});

describe("[FL-113] and of PublicWeb", () => {
  it.each(WRONG_ORIGINS)("%s: 403 for the page and its POSTs", async (_label, edge) => {
    const world = await publicWebWorld();
    for (const event of [publicEvent("GET", "/u/Zq3v9Kf0mX2bR7wLpT4yNc8hJd1sGa6eUo5iQkVxWtY"), publicEvent("POST", "/u/Zq3v9Kf0mX2bR7wLpT4yNc8hJd1sGa6eUo5iQkVxWtY/presign", { body: {} })]) {
      const headers = Object.fromEntries(Object.entries(event.headers).filter(([name]) => name !== "x-origin-verify"));
      const response = await world.handler({ ...event, headers: { ...headers, ...edge } });
      expect(response.statusCode).toBe(403);
    }
    expect(world.logs().filter((line) => line.message === "public_web.post_refused" || String(line.message).startsWith("upload"))).toEqual([]);
  });
});
