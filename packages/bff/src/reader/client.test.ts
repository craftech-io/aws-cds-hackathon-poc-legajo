import { S3Client } from "@aws-sdk/client-s3";
import { READER_LIMITS } from "@legajo/reader-contract";
import { FAULT_DELAYS_MS, createMemoryCatalog, createReaderApp, documentsSourceUrl, faultItem, groundTruthItems, type FaultItem, type GroundTruthReading } from "@legajo/reader-mock";
import { fakeDocumentsBucket, inProcessReaderFetch, sha256Of, syntheticPdf, type RecordedRequest } from "@legajo/reader-mock/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../lib/log";
import { READER_CLIENT_DEFAULTS, createReaderClient, parseRetryAfter, type ReaderClientDeps, type ReaderFetch } from "./client";
import { ReaderError, isReaderUnavailable } from "./errors";
import { functionUrlRegion, sigV4Signer } from "./signer";
import { createSourceUrlSigner } from "./source-url";

const ENDPOINT = "https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/";
const BUCKET = "legajo-poc-documentsbucket-7f3a9c";
const NOW = new Date("2026-10-15T13:05:00.000Z");
const QA_CLOCK = "qa-812-1-sc19";
const CREDENTIALS = { accessKeyId: "AKIDTESTONLY", secretAccessKey: "test-only-secret" };
const PDF = syntheticPdf({ LegajoDocId: "LDOC-4471-PL-v1" });
const OBJECT_KEY = `ops/op-4471/PACKING_LIST/v001-${sha256Of(PDF).slice(0, 8)}.pdf`;
const TRUTH: GroundTruthReading = {
  status: "RECOGNIZED",
  docType: "PACKING_LIST",
  confidence: 0.97,
  fields: { grossWeightKg: 12480 },
  observations: [{ code: "GROSS_WEIGHT_MISMATCH", severity: "BLOCKING", expected: "12840", found: "12480", againstDocType: "COMMERCIAL_INVOICE" }],
};
const s3 = new S3Client({ region: "us-east-1", credentials: CREDENTIALS });
const presign = createSourceUrlSigner({ bucket: BUCKET, s3 });

afterEach(() => {
  vi.useRealTimers();
});

function setup(overrides: Partial<ReaderClientDeps> = {}) {
  const catalog = createMemoryCatalog(groundTruthItems({ sha256: sha256Of(PDF), docId: "LDOC-4471-PL-v1", reading: TRUTH }));
  const bucket = fakeDocumentsBucket();
  bucket.put(OBJECT_KEY, PDF);
  // TIMEOUT answers after the client has given up: in process, that is never.
  const mockSleep = (ms: number) => (ms >= FAULT_DELAYS_MS.timeout ? new Promise<void>(() => undefined) : Promise.resolve());
  const app = createReaderApp({ catalog, documentsBucket: BUCKET, fetchSource: bucket.fetch, now: () => NOW, random: () => 0, sleep: mockSleep });
  const recorded: RecordedRequest[] = [];
  const sleeps: number[] = [];
  const logLines: string[] = [];
  const client = createReaderClient({
    endpoint: ENDPOINT,
    sign: sigV4Signer({ credentials: CREDENTIALS, signingDate: () => NOW }),
    fetch: inProcessReaderFetch(app, recorded),
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    nowMs: () => NOW.getTime(),
    logger: createLogger({ level: "debug", sink: (line) => logLines.push(line) }),
    ...overrides,
  });
  const read = async (clockId = QA_CLOCK, docVersionId = "dv-4471-PL-1") => client.createReading({ docVersionId, sha256: sha256Of(PDF), sourceUrl: await presign(OBJECT_KEY), clockId });
  const setFaults = (mode: FaultItem["mode"], clockId = QA_CLOCK) => catalog.setFaults(faultItem(clockId, { mode, until: "2026-10-15T14:00:00Z" }, NOW));
  return { client, catalog, recorded, sleeps, logLines, read, setFaults };
}

/** A fetch that answers from a script, one entry per call (the last one repeats). */
function scripted(responses: Array<() => Response | Promise<Response>>, calls: string[] = []): ReaderFetch {
  return async (url) => {
    calls.push(url);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next === undefined) throw new Error("empty script");
    return next();
  };
}

const error503 = (retryAfter?: string) => () => new Response('{"code":"UNAVAILABLE","message":"x"}', { status: 503, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } });

async function failure(promise: Promise<unknown>): Promise<ReaderError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ReaderError);
  return error as ReaderError;
}

describe("[FL-096] reader client · the reader is unavailable", () => {
  it("[FL-096] retries a 503 three times, never before Retry-After, then fails READER_UNAVAILABLE without a reading", async () => {
    const { read, setFaults, recorded, sleeps, logLines } = setup();
    setFaults("ERROR_503");
    const error = await failure(read());
    expect(isReaderUnavailable(error)).toBe(true);
    expect(error.details).toMatchObject({ attempts: 4, status: 503, retryAfterMs: 1_000 });
    expect(recorded).toHaveLength(1 + READER_CLIENT_DEFAULTS.maxRetries);
    expect(sleeps).toHaveLength(3);
    for (const delay of sleeps) expect(delay).toBeGreaterThanOrEqual(1_000);
    expect(logLines.some((line) => line.includes('"metric":"ReaderErrors"'))).toBe(true);
  });

  it("[FL-096] backs off exponentially with full jitter when there is no Retry-After", async () => {
    const calls: string[] = [];
    const { client, sleeps } = setup({ fetch: scripted([error503()], calls), random: () => 0.5 });
    await failure(client.health());
    expect(calls).toHaveLength(4);
    // floor(random × min(2 000, 250 × 2^n)) with random = 0.5
    expect(sleeps).toEqual([125, 250, 500]);
  });

  it("[FL-096] cuts every attempt at 8 s and retries the timeout", async () => {
    vi.useFakeTimers();
    const hanging: ReaderFetch = () => new Promise<Response>(() => undefined);
    const quiet = createLogger({ sink: () => undefined });
    const client = createReaderClient({ endpoint: ENDPOINT, sign: async () => ({}), fetch: hanging, sleep: async () => undefined, maxRetries: 1, logger: quiet });
    const settled = vi.fn();
    const pending = client.health().then(settled, (error: unknown) => settled(error));
    await vi.advanceTimersByTimeAsync(READER_CLIENT_DEFAULTS.timeoutMs - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(READER_CLIENT_DEFAULTS.timeoutMs + 1);
    await pending;
    const error = settled.mock.calls[0]?.[0] as ReaderError;
    expect(error).toBeInstanceOf(ReaderError);
    expect(error.details.attempts).toBe(2);
  });

  it("[FL-096] fails after the world's TIMEOUT fault and reads normally once the reader is back", async () => {
    const { read, setFaults, catalog, recorded } = setup({ timeoutMs: 20 });
    setFaults("TIMEOUT");
    expect(isReaderUnavailable(await failure(read()))).toBe(true);
    expect(recorded).toHaveLength(4);
    catalog.clearFaults(QA_CLOCK);
    const reading = await read();
    expect(reading).toMatchObject({ status: "RECOGNIZED", docType: "PACKING_LIST", matchedBy: "SHA256", observations: TRUTH.observations });
  });

  it("[FL-096] sends X-Fault-Scope only for qa-* clocks, so a scenario's faults never reach a demo or judge world", async () => {
    const { read, setFaults, recorded } = setup();
    setFaults("ERROR_503");
    expect((await read("GLOBAL#firm-delta")).status).toBe("RECOGNIZED");
    expect((await read("JUDGE#firm-judge-01", "dv-4471-j01-PL-1")).status).toBe("RECOGNIZED");
    expect(recorded.map((request) => request.headers["x-fault-scope"])).toEqual([undefined, undefined]);
    await failure(read(QA_CLOCK, "dv-4471-PL-2"));
    expect(recorded.at(-1)?.headers["x-fault-scope"]).toBe(QA_CLOCK);
  });

  it("[FL-096] gives up at once when Retry-After is longer than an invocation can wait", async () => {
    const calls: string[] = [];
    const { client, sleeps } = setup({ fetch: scripted([error503("30")], calls) });
    const error = await failure(client.health());
    expect([calls.length, sleeps.length, error.code, error.details.retryAfterMs]).toEqual([1, 0, "READER_UNAVAILABLE", 30_000]);
  });

  it("recovers from a 429 and from a network error on the next attempt", async () => {
    const ok = () => new Response('{"status":"ok","readerVersion":"reader-mock-1.0.0"}', { status: 200 });
    const limited = setup({ fetch: scripted([() => new Response("{}", { status: 429, headers: { "Retry-After": "1" } }), ok]) });
    expect(await limited.client.health()).toEqual({ status: "ok", readerVersion: "reader-mock-1.0.0" });
    expect(limited.sleeps).toEqual([1_000]);
    const flaky = setup({ fetch: scripted([() => Promise.reject(new TypeError("fetch failed")), ok]) });
    expect((await flaky.client.health()).status).toBe("ok");
  });
});

describe("reader client · contract, signature and errors", () => {
  it("signs with SigV4 for lambda in the endpoint's region and sends the docVersionId as Idempotency-Key", async () => {
    const { read, recorded } = setup();
    await read();
    const [request] = recorded;
    expect(request?.headers["idempotency-key"]).toBe("dv-4471-PL-1");
    expect(request?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTESTONLY\/20261015\/us-east-1\/lambda\/aws4_request, SignedHeaders=[^,]*idempotency-key/);
    expect(request?.headers.host).toBeUndefined();
    expect(functionUrlRegion(new URL(ENDPOINT))).toBe("us-east-1");
  });

  it("maps final answers without retrying: 400, 413, 403 and a 200 outside the contract", async () => {
    const cases: Array<[number, string, string]> = [
      [400, '{"code":"INVALID_REQUEST","message":"x"}', "INVALID_REQUEST"],
      [413, '{"code":"FILE_TOO_LARGE","message":"x"}', "FILE_TOO_LARGE"],
      [403, '{"Message":"Forbidden"}', "READER_UNAVAILABLE"],
      [200, '{"readingId":"r","status":"GUESSED"}', "INVALID_RESPONSE"],
    ];
    for (const [status, body, code] of cases) {
      const calls: string[] = [];
      const { client } = setup({ fetch: scripted([() => new Response(body, { status })], calls) });
      const error = await failure(client.health());
      expect([error.code, calls.length]).toEqual([code, 1]);
    }
  });

  it("validates its input before calling: a docVersionId, a clock id, a hex SHA-256 and a URL", async () => {
    const { client, recorded } = setup();
    const valid = { docVersionId: "dv-4471-PL-1", sha256: sha256Of(PDF), sourceUrl: await presign(OBJECT_KEY), clockId: QA_CLOCK };
    for (const input of [{ ...valid, docVersionId: "op-4471" }, { ...valid, clockId: "firm-delta" }, { ...valid, sha256: "ABC" }, { ...valid, sourceUrl: "not a url" }]) {
      await expect(client.createReading(input)).rejects.toThrow();
    }
    expect(recorded).toEqual([]);
  });

  it("gets a reading by id and answers NOT_FOUND for an unknown one", async () => {
    const { client, read } = setup();
    const created = await read();
    expect(await client.getReading(created.readingId)).toEqual(created);
    expect((await failure(client.getReading("rdg-unknown"))).code).toBe("NOT_FOUND");
    expect(await client.health()).toEqual({ status: "ok", readerVersion: "reader-mock-1.0.0" });
  });

  it("pre-signs a 5-minute GET of Documents that the reader accepts, and never logs it", async () => {
    const url = await presign(OBJECT_KEY);
    const parsed = documentsSourceUrl(url, BUCKET);
    expect(parsed?.hostname).toBe(`${BUCKET}.s3.us-east-1.amazonaws.com`);
    expect(parsed?.searchParams.get("X-Amz-Expires")).toBe(String(READER_LIMITS.sourceUrlTtlSeconds));
    await expect(presign("/absolute")).rejects.toThrow(RangeError);
    const { setFaults, read, logLines } = setup();
    setFaults("ERROR_503");
    await failure(read());
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toMatch(/X-Amz-Signature|amazonaws\.com/);
  });

  it("parses Retry-After as seconds or as an HTTP date", () => {
    expect(parseRetryAfter("2", NOW.getTime())).toBe(2_000);
    expect(parseRetryAfter(new Date(NOW.getTime() + 3_000).toUTCString(), NOW.getTime())).toBe(3_000);
    expect(parseRetryAfter("soon", NOW.getTime())).toBeUndefined();
    expect(parseRetryAfter(null, NOW.getTime())).toBeUndefined();
  });
});
