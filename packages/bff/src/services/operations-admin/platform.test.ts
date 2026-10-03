// The one platform client (FL-005, FL-078): the firm scopes every route, a 404 is NOT_FOUND, a 409
// keeps the platform's reason, a 5xx is retried and then UNAVAILABLE, and a body that is not this
// firm's operation never becomes one.
import { describe, expect, it } from "vitest";
import { createPlatformClient } from "./platform";

const ENDPOINT = "https://platform.lambda-url.us-east-1.on.aws/";
const sign = async ({ headers }: { headers: Readonly<Record<string, string>> }) => ({ ...headers, authorization: "AWS4-HMAC-SHA256 test" });

function client(answers: Array<() => Response>) {
  const seen: Array<{ url: string; method: string; body?: string }> = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method), ...(typeof init.body === "string" ? { body: init.body } : {}) });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("no answer left");
    return answer();
  }) as unknown as typeof fetch;
  return { seen, platform: createPlatformClient({ endpoint: () => ENDPOINT, sign, fetch: doFetch, sleep: () => Promise.resolve() }) };
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
const feed = { firmId: "firm-qa", operationNumber: "7001", occurredAtSim: "2026-10-15T09:58:00-03:00", idempotencyKey: "812-1/sc10/1/m1" };

describe("[FL-005] [FL-078] the platform client", () => {
  it("answers NOT_FOUND for an operation the firm does not have, and refuses another firm's body", async () => {
    const { platform, seen } = client([json(404, { error: { code: "NOT_FOUND", message: "no" } }), json(200, { firmId: "firm-delta", operationNumber: "7001" })]);
    await expect(platform.get("firm-qa", "7001")).rejects.toMatchObject({ code: "NOT_FOUND", reason: "PLATFORM_NOT_FOUND" });
    expect(seen[0]?.url).toBe(`${ENDPOINT}v1/operations/7001?firm=firm-qa`);
    await expect(platform.get("firm-qa", "7001")).rejects.toMatchObject({ code: "UNAVAILABLE", reason: "PLATFORM_INVALID" });
  });

  it("keeps the platform's reason on a 409 and never retries it", async () => {
    const { platform, seen } = client([json(409, { error: { code: "CONFLICT", message: "same", reason: "ETA_UNCHANGED" } })]);
    await expect(platform.moveEta({ ...feed, newEta: "2026-10-20T08:00:00-03:00" })).rejects.toMatchObject({ code: "CONFLICT", reason: "ETA_UNCHANGED" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: `${ENDPOINT}v1/operations/7001/eta?firm=firm-qa` });
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ newEta: "2026-10-20T08:00:00-03:00", occurredAtSim: feed.occurredAtSim });
  });

  it("retries a 503 and then answers UNAVAILABLE", async () => {
    const { platform, seen } = client([json(503, {}), json(503, {}), json(503, {})]);
    await expect(platform.customsStatus({ ...feed, status: "CANAL_ASIGNADO", channel: "VERDE" })).rejects.toMatchObject({ code: "UNAVAILABLE", reason: "PLATFORM_UNAVAILABLE" });
    expect(seen).toHaveLength(3);
    expect(seen[0]?.url).toBe(`${ENDPOINT}v1/operations/7001/customs-status?firm=firm-qa`);
  });
});
