// The one client of the customs platform (`PlatformMock`, docs/architecture-integrations.md §6), a
// Function URL with `AWS_IAM` signed with SigV4 (service `lambda`, capability `MOCK_PLATFORM`), used by
// `create_operation` (FL-005), the console's "Mover ETA" and "Emitir estado de despacho" and the
// `QaDriver`'s `platform.get` / `feed.*`:
//
//   get            GET  /v1/operations/{n}?firm=   404 is `NOT_FOUND` (no such operation for this firm);
//                  a body that is not this firm's `PlatformOperation` is `UNAVAILABLE`: nothing half-read
//                  becomes an operation
//   moveEta        POST …/eta, customsStatus POST …/customs-status, with the caller's `Idempotency-Key`
//                  (a retry re-publishes the same event); 404 is `NOT_FOUND`, 409 `CONFLICT` with the
//                  platform's reason (`ETA_UNCHANGED`, `STATUS_NOT_FORWARD`, `IDEMPOTENCY_KEY_REUSED`, …)
//
// A timeout, a network error, a 429 or a 5xx is retried with backoff and then `UNAVAILABLE`.
import { z } from "zod";
import { CORRELATION_HEADER, IDEMPOTENCY_HEADER, PlatformErrorBody, PlatformEventResponse, platformPaths } from "@legajo/platform-mock/api";
import { PlatformOperation } from "@legajo/platform-mock/schema";
import { OperationNumber, ToolError } from "@legajo/shared";
import { readLinked } from "../../lib/resource";
import { withRetry } from "../../lib/retry";
import { type RequestSigner, type SignableRequest, sigV4Signer } from "../../reader/signer";

export const PLATFORM_TIMEOUT_MS = 3_000;
export const PLATFORM_ATTEMPTS = 3;

export interface PlatformFeedInput {
  readonly firmId: string;
  readonly operationNumber: string;
  readonly occurredAtSim: string;
  readonly idempotencyKey: string;
}

export interface PlatformOperations {
  /** Master data of an operation of `firmId`; `NOT_FOUND` when the platform has none. */
  get(firmId: string, operationNumber: string): Promise<PlatformOperation>;
  /** The carrier's new ETA, published by the platform to `Feeds` (`CarrierEtaChanged`). */
  moveEta(input: PlatformFeedInput & { readonly newEta: string }): Promise<PlatformEventResponse>;
  /** A customs status, published by the platform to `Feeds` (`CustomsStatusChanged`). */
  customsStatus(input: PlatformFeedInput & { readonly status: string; readonly channel?: string }): Promise<PlatformEventResponse>;
}

export interface PlatformClientDeps {
  readonly endpoint: () => string;
  readonly sign: RequestSigner;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

class PlatformCallError extends Error {
  override readonly name = "PlatformCallError";
  constructor(
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(`the platform answered ${status}`);
  }
}

function isRetryableCall(error: unknown): boolean {
  if (error instanceof PlatformCallError) return error.retryable;
  return error instanceof TypeError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
}

/** A refusal the platform explained (4xx other than 429): final, never retried. */
async function refusalOf(response: Response): Promise<ToolError> {
  const body = PlatformErrorBody.safeParse(await response.json().catch(() => ({})));
  const reason = body.success ? (body.data.error.reason ?? body.data.error.code) : `HTTP_${response.status}`;
  if (response.status === 404) return new ToolError("NOT_FOUND", "the customs platform has no operation with that number for this firm", "PLATFORM_NOT_FOUND");
  if (response.status === 409) return new ToolError("CONFLICT", "the customs platform refused the change", reason);
  return new ToolError("INVALID", "the customs platform refused the request", reason);
}

export function createPlatformClient(deps: PlatformClientDeps): PlatformOperations {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PLATFORM_TIMEOUT_MS;

  async function call(method: "GET" | "POST", path: string, headers: Readonly<Record<string, string>>, body?: unknown): Promise<unknown> {
    const url = new URL(path, deps.endpoint()) as SignableRequest["url"];
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const base = { accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers };
    try {
      return await withRetry(
        async () => {
          const signed = await deps.sign({ method, url, headers: base, ...(payload === undefined ? {} : { body: payload }) });
          const response = await doFetch(url.href, { method, headers: signed, ...(payload === undefined ? {} : { body: payload }), signal: AbortSignal.timeout(timeoutMs) });
          if (response.ok) return (await response.json()) as unknown;
          if (response.status === 429 || response.status >= 500) throw new PlatformCallError(response.status, true);
          throw await refusalOf(response);
        },
        { attempts: deps.attempts ?? PLATFORM_ATTEMPTS, shouldRetry: isRetryableCall, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) },
      );
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("UNAVAILABLE", "the customs platform did not answer, try again later", "PLATFORM_UNAVAILABLE", { cause: error });
    }
  }

  const feedHeaders = (key: string) => ({ [IDEMPOTENCY_HEADER]: key, [CORRELATION_HEADER]: key.replaceAll("/", "-") });
  const event = (body: unknown): PlatformEventResponse => {
    const parsed = PlatformEventResponse.safeParse(body);
    if (!parsed.success) throw new ToolError("UNAVAILABLE", "the customs platform answered something that is not an event", "PLATFORM_INVALID");
    return parsed.data;
  };

  return {
    async get(firmId, operationNumber) {
      const number = OperationNumber.parse(operationNumber);
      const parsed = PlatformOperation.safeParse(await call("GET", platformPaths.operation(firmId, number), {}));
      if (!parsed.success || parsed.data.firmId !== firmId || parsed.data.operationNumber !== number) {
        throw new ToolError("UNAVAILABLE", "the customs platform answered something that is not this operation", "PLATFORM_INVALID");
      }
      return parsed.data;
    },
    async moveEta(input) {
      return event(await call("POST", platformPaths.eta(input.firmId, input.operationNumber), feedHeaders(input.idempotencyKey), { newEta: input.newEta, occurredAtSim: input.occurredAtSim }));
    },
    async customsStatus(input) {
      const body = { status: input.status, ...(input.channel === undefined ? {} : { channel: input.channel }), occurredAtSim: input.occurredAtSim };
      return event(await call("POST", platformPaths.customsStatus(input.firmId, input.operationNumber), feedHeaders(input.idempotencyKey), body));
    },
  };
}

const FunctionUrlLink = z.object({ url: z.url() });

/** The platform of a Lambda that links `PlatformMock` (its Function URL and `MOCK_PLATFORM`). */
export function linkedPlatformClient(options: { readonly sign?: RequestSigner; readonly sleep?: (ms: number) => Promise<void> } = {}): PlatformOperations {
  return createPlatformClient({ endpoint: () => readLinked("PlatformMock", FunctionUrlLink).url, sign: options.sign ?? sigV4Signer(), ...(options.sleep === undefined ? {} : { sleep: options.sleep }) });
}
