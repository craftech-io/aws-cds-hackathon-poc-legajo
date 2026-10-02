import { createHash } from "node:crypto";
import { getUntypedClient } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_SHA256_HEADER } from "./body-hash";
import { AUTH_HEADER, type ConsoleRefusal, createConsoleClient, refusalsOf } from "./trpc";
import { wafErrorOf } from "./waf";

interface Sent {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

let sent: Sent[];
let reply: (request: Sent) => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// tRPC's own answer for what was asked: one result per procedure of a batch, one object otherwise.
function echo(request: Sent): Response {
  const procedures = decodeURIComponent(request.url.pathname.replace(/^\/api\//, "")).split(",");
  const results = procedures.map((path) => ({ result: { data: { path } } }));
  return json(200, request.url.searchParams.get("batch") === "1" ? results : results[0]);
}

beforeEach(() => {
  sent = [];
  reply = echo;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Sent = {
      url: new URL(String(input), "http://legajo.test"),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    sent.push(request);
    return reply(request);
  });
});

afterEach(() => vi.unstubAllGlobals());

function client(token: string | null = "id-token-1", onRefusal?: (refusal: ConsoleRefusal) => void) {
  return getUntypedClient(createConsoleClient({ getIdToken: () => token ?? undefined, ...(onRefusal ? { onRefusal } : {}) }));
}

describe("[FL-113] tRPC client: sign-up calls never travel in a batch (ADR-0015 §3.1)", () => {
  it("[FL-113] sends each signup.* call alone, even when several start together", async () => {
    const trpc = client();
    await Promise.all([
      trpc.query("signup.form", { lang: "es" }),
      trpc.mutation("signup.start", { email: "a@sim.legajo.demo.craftech.io" }),
      trpc.mutation("signup.resend", { signupId: "x" }),
      trpc.query("account.usage", undefined),
      trpc.query("clock.get", undefined),
    ]);
    const signup = sent.filter((request) => request.url.pathname.includes("signup."));
    expect(signup.map((request) => request.url.pathname).sort()).toEqual(["/api/signup.form", "/api/signup.resend", "/api/signup.start"]);
    for (const request of signup) {
      expect(request.url.pathname).not.toContain(",");
      expect(request.url.searchParams.has("batch")).toBe(false);
      expect(request.headers.has(AUTH_HEADER)).toBe(false);
    }
    // The console's own calls still share one batch.
    const batched = sent.filter((request) => !request.url.pathname.includes("signup."));
    expect(batched).toHaveLength(1);
    expect(batched[0]?.url.searchParams.get("batch")).toBe("1");
    expect(decodeURIComponent(batched[0]?.url.pathname ?? "")).toBe("/api/account.usage,clock.get");
  });

  it("[FL-113] carries the id token in X-Legajo-Auth, never in Authorization", async () => {
    await client("tok-xyz").query("clock.get", undefined);
    expect(sent[0]?.headers.get(AUTH_HEADER)).toBe("Bearer tok-xyz");
    expect(sent[0]?.headers.has("authorization")).toBe(false);
    sent = [];
    await client(null).query("clock.get", undefined);
    expect(sent[0]?.headers.has(AUTH_HEADER)).toBe(false);
  });

  it("[FL-113] signs the body of every POST with its SHA-256", async () => {
    await Promise.all([client().mutation("signup.confirm", { signupId: "s", code: "123456", password: "Clave-Larga-2026!" }), client().mutation("clock.advance", { hours: 1 })]);
    const posts = sent.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.body).toBeDefined();
      expect(post.headers.get(CONTENT_SHA256_HEADER)).toBe(createHash("sha256").update(post.body ?? "", "utf8").digest("hex"));
    }
    const get = sent.find((request) => request.method === "GET");
    expect(get).toBeUndefined();
  });

  it("[FL-113] turns WAF's challenge and WAF's HTML 403 on a signup.* call into their errors", async () => {
    reply = () => new Response("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
    const challenge = await client().mutation("signup.start", {}).catch((error: unknown) => error);
    expect(wafErrorOf(challenge)).toBe("challenge");
    reply = () => new Response("<html>blocked</html>", { status: 403, headers: { "content-type": "text/html" } });
    const blocked = await client().mutation("signup.start", {}).catch((error: unknown) => error);
    expect(wafErrorOf(blocked)).toBe("blocked");
    expect(sent.filter((request) => request.method === "POST")).toHaveLength(2);
  });

  it("reports a guest world that is gone and a usage quota, wherever the call came from", async () => {
    const refusals: ConsoleRefusal[] = [];
    reply = () =>
      json(207, [
        { error: { message: "gone", code: -32_603, data: { code: "FORBIDDEN", httpStatus: 403, reason: "GUEST_WORLD_GONE", path: "clock.get" } } },
        { error: { message: "quota", code: -32_603, data: { code: "TOO_MANY_REQUESTS", httpStatus: 429, reason: "QUOTA_EXCEEDED", path: "clock.advance", quota: { kind: "CLOCK_MOVES" } } } },
      ]);
    const trpc = client("t", (refusal) => refusals.push(refusal));
    await Promise.allSettled([trpc.query("clock.get", undefined), trpc.query("operations.list", undefined)]);
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["GUEST_WORLD_GONE", "QUOTA_EXCEEDED"]);
    expect(refusals[1]?.data.quota).toEqual({ kind: "CLOCK_MOVES" });
  });

  it("reads refusals from one answer or a batch, and nothing from a success", () => {
    expect(refusalsOf({ error: { data: { reason: "GUEST_WORLD_GONE" } } }).map((refusal) => refusal.reason)).toEqual(["GUEST_WORLD_GONE"]);
    expect(refusalsOf([{ result: { data: 1 } }])).toEqual([]);
    expect(refusalsOf("nope")).toEqual([]);
  });
});
