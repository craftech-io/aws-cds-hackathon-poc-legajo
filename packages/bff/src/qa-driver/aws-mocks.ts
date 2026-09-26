// The two external mocks as the `QaDriver` reaches them with its own role (docs/architecture.md §14:
// `MOCK_PLATFORM`, `MOCK_READER`; docs/architecture-integrations.md §5-§6):
//
//   platform.get          GET  /v1/operations/{n}?firm=            (read only; QA firms)
//   feed.eta, feed.customs POST /v1/operations/{n}/eta | customs-status, `Idempotency-Key` = the step's key
//   probe.mocks           GET  /v1/health of both mocks (the health checks the console uses)
//   reader.setFaults      `ReaderCatalog` CONFIG / FAULTS#<clockId> built by the reader mock's own item builder
//
// SigV4 on the Function URLs (reader/signer.ts), with timeout and backoff on every call.
import { z } from "zod";
import { ToolError } from "@legajo/shared";
import { CORRELATION_HEADER, IDEMPOTENCY_HEADER, PlatformErrorBody, PlatformEventResponse, platformPaths } from "@legajo/platform-mock/api";
import { PlatformOperation } from "@legajo/platform-mock/schema";
import { type FaultConfigInput, faultItem } from "@legajo/reader-mock/catalog";
import { type Item, tableClient } from "../connector/index";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { type RequestSigner, sigV4Signer } from "../reader/signer";
import { functionUrlHealthCheck } from "../routers/health";

const FunctionUrlLink = z.object({ url: z.url() });
const TIMEOUT_MS = 5_000;
const ATTEMPTS = 3;

class PlatformCallError extends Error {
  override readonly name = "PlatformCallError";
  constructor(
    readonly status: number,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface MocksDeps {
  readonly platformUrl?: () => string;
  readonly readerUrl?: () => string;
  readonly sign?: RequestSigner;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function platformClient(deps: MocksDeps = {}) {
  const endpoint = deps.platformUrl ?? (() => readLinked("PlatformMock", FunctionUrlLink).url);
  const sign = deps.sign ?? sigV4Signer();
  const doFetch = deps.fetch ?? fetch;

  async function call(method: "GET" | "POST", path: string, headers: Record<string, string>, body?: unknown): Promise<unknown> {
    const url = new URL(path, endpoint());
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return withRetry(
      async () => {
        const base = { accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers };
        const signed = await sign({ method, url, headers: base, ...(payload === undefined ? {} : { body: payload }) });
        const response = await doFetch(url.href, { method, headers: signed, ...(payload === undefined ? {} : { body: payload }), signal: AbortSignal.timeout(TIMEOUT_MS) });
        const json: unknown = await response.json().catch(() => ({}));
        if (response.ok) return json;
        const error = PlatformErrorBody.safeParse(json);
        const detail = error.success ? `${error.data.error.code}${error.data.error.reason ? ` ${error.data.error.reason}` : ""}` : `HTTP ${response.status}`;
        throw new PlatformCallError(response.status, response.status === 429 || response.status >= 500, detail);
      },
      { attempts: ATTEMPTS, shouldRetry: (error) => (error instanceof PlatformCallError ? error.retryable : error instanceof TypeError), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
    ).catch((error: unknown) => {
      if (error instanceof PlatformCallError) throw new ToolError(error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : "UNAVAILABLE", `platform mock: ${error.message}`);
      throw error;
    });
  }

  return {
    async get(firmId: string, operationNumber: string) {
      return PlatformOperation.parse(await call("GET", platformPaths.operation(firmId, operationNumber), {}));
    },
    async moveEta(input: { readonly firmId: string; readonly operationNumber: string; readonly newEta: string; readonly occurredAtSim: string; readonly idempotencyKey: string }) {
      const headers = { [IDEMPOTENCY_HEADER]: input.idempotencyKey, [CORRELATION_HEADER]: input.idempotencyKey.replaceAll("/", "-") };
      return PlatformEventResponse.parse(await call("POST", platformPaths.eta(input.firmId, input.operationNumber), headers, { newEta: input.newEta, occurredAtSim: input.occurredAtSim }));
    },
    async customsStatus(input: { readonly firmId: string; readonly operationNumber: string; readonly status: string; readonly channel?: string; readonly occurredAtSim: string; readonly idempotencyKey: string }) {
      const headers = { [IDEMPOTENCY_HEADER]: input.idempotencyKey, [CORRELATION_HEADER]: input.idempotencyKey.replaceAll("/", "-") };
      const body = { status: input.status, ...(input.channel === undefined ? {} : { channel: input.channel }), occurredAtSim: input.occurredAtSim };
      return PlatformEventResponse.parse(await call("POST", platformPaths.customsStatus(input.firmId, input.operationNumber), headers, body));
    },
  };
}

export type PlatformClient = ReturnType<typeof platformClient>;

/** `GET /v1/health` of both mocks with the driver's role: `ok` or `unavailable` each. */
export function mocksHealth(deps: MocksDeps = {}) {
  const sign = deps.sign ?? sigV4Signer();
  const check = (name: string, endpoint: () => string) =>
    functionUrlHealthCheck({ name, endpoint, sign, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  const checks = [
    check("reader", deps.readerUrl ?? (() => readLinked("ReaderMock", FunctionUrlLink).url)),
    check("platform", deps.platformUrl ?? (() => readLinked("PlatformMock", FunctionUrlLink).url)),
  ];
  return async (): Promise<Record<string, "ok" | "unavailable">> => {
    const results = await Promise.all(
      checks.map(async (probe) => {
        try {
          await probe.run();
          return [probe.name, "ok"] as const;
        } catch {
          return [probe.name, "unavailable"] as const;
        }
      }),
    );
    return Object.fromEntries(results);
  };
}

/** Writes the faults of one `qa-*` world into `ReaderCatalog` (through the connector's table client); the builder refuses any other clock. */
export function readerFaultWriter(options: { readonly put?: (item: Item) => Promise<void> } = {}) {
  const put = options.put ?? ((item: Item) => tableClient().put("ReaderCatalog", item));
  return async (clockId: string, config: FaultConfigInput, now: Date) => {
    const item = faultItem(clockId, config, now);
    await put(item);
    return { clockId, mode: item.mode, rate: item.rate, until: item.until };
  };
}
