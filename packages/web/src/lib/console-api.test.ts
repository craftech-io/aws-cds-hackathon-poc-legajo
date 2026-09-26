import { afterEach, describe, expect, it, vi } from "vitest";
import { toApiError } from "./api-error";
import { AccountSession, fetchAccountSession, fetchClock, moveClock } from "./console-api";
import { createConsoleClient } from "./trpc";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

const CLOCK = { clockId: "JUDGE#firm-judge-01", mode: "PAUSED", simNow: "2026-10-14T10:30:00-03:00", busy: false, pending: [] };

/** Answers tRPC batch requests with one result (or error) per procedure of the batch. */
function stubBff(answer: (path: string) => { data?: unknown; error?: { code: string; httpStatus: number; reason?: string } }) {
  const sent: Sent[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    sent.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined });
    const paths = decodeURIComponent(url.slice(url.indexOf("/api/") + 5).split("?")[0] ?? "").split(",");
    const items = paths.map((path) => {
      const result = answer(path);
      if (result.error) return { error: { message: "refused", code: -32_603, data: { ...result.error, path, correlationId: "corr-1" } } };
      return { result: { data: result.data } };
    });
    return new Response(JSON.stringify(items), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shell procedures over tRPC (clock and account routers)", () => {
  it("reads clock.get with the id token and validates the answer", async () => {
    const sent = stubBff(() => ({ data: { ...CLOCK, next: [] } }));
    const trpc = createConsoleClient(() => "id-token");
    const clock = await fetchClock(trpc);
    expect(clock).toMatchObject({ mode: "PAUSED", simNow: "2026-10-14T10:30:00-03:00", busy: false });
    expect(sent[0]?.url).toMatch(/^\/api\/clock\.get\?batch=1/);
    expect(sent[0]?.method).toBe("GET");
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer id-token");
  });

  it("rejects an answer that does not have the contract's shape", async () => {
    stubBff(() => ({ data: { ...CLOCK, mode: "STOPPED" } }));
    await expect(fetchClock(createConsoleClient(() => "t"))).rejects.toThrow();
  });

  it("moves the clock with a mutation and keeps the BFF's WORLD_BUSY reason", async () => {
    const sent = stubBff((path) => (path === "clock.advance" ? { error: { code: "CONFLICT", httpStatus: 409, reason: "WORLD_BUSY" } } : { data: CLOCK }));
    const trpc = createConsoleClient(() => "t");
    expect(await moveClock(trpc, { kind: "next" }, true)).toMatchObject({ clockId: "JUDGE#firm-judge-01" });
    expect(sent[0]).toMatchObject({ method: "POST" });
    expect(sent[0]?.url).toMatch(/^\/api\/clock\.advanceToNext\?batch=1/);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({ 0: { force: true } });

    const refused = await moveClock(trpc, { kind: "by", minutes: 60 }).catch((error: unknown) => toApiError(error));
    expect(refused).toMatchObject({ kind: "conflict", reason: "WORLD_BUSY" });
    expect(JSON.parse(sent[1]?.body ?? "{}")).toEqual({ 0: { minutes: 60 } });
  });

  it("reads the firm's name and a judge's other session from account.session", async () => {
    stubBff(() => ({ data: { firm: { name: "Estudio Delta" }, otherSession: { lastActiveAtReal: "2026-10-01T12:00:00Z" } } }));
    expect(await fetchAccountSession(createConsoleClient(() => "t"))).toEqual({ firm: { name: "Estudio Delta" }, otherSession: { lastActiveAtReal: "2026-10-01T12:00:00Z" } });
    expect(AccountSession.parse({})).toEqual({});
    expect(AccountSession.safeParse({ otherSession: { lastActiveAtReal: "ayer" } }).success).toBe(false);
  });
});
