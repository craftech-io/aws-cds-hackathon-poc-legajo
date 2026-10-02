// The customs platform as `create_operation` reads it (FL-005): `GET /v1/operations/{n}?firm=<firmId>`
// of `PlatformMock`, a Function URL with `AWS_IAM` signed with SigV4 (service `lambda`, capability
// `MOCK_PLATFORM`). 404 is `NOT_FOUND` (the platform has no such operation for this firm); a timeout,
// a network error, a 429 or a 5xx is retried with backoff and then `UNAVAILABLE`; any other answer, or
// a body that is not a `PlatformOperation`, is `UNAVAILABLE` too: nothing half-read becomes an operation.
import { z } from "zod";
import { PlatformOperation } from "@legajo/platform-mock/schema";
import { OperationNumber, ToolError } from "@legajo/shared";
import { readLinked } from "../../lib/resource";
import { withRetry } from "../../lib/retry";
import { type RequestSigner, type SignableRequest, sigV4Signer } from "../../reader/signer";

export const PLATFORM_TIMEOUT_MS = 3_000;
export const PLATFORM_ATTEMPTS = 3;

export interface PlatformOperations {
  /** Master data of an operation of `firmId`; `NOT_FOUND` when the platform has none. */
  get(firmId: string, operationNumber: string): Promise<PlatformOperation>;
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

export function createPlatformClient(deps: PlatformClientDeps): PlatformOperations {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PLATFORM_TIMEOUT_MS;
  return {
    async get(firmId, operationNumber) {
      const number = OperationNumber.parse(operationNumber);
      const url = new URL(`/v1/operations/${number}`, deps.endpoint()) as SignableRequest["url"];
      url.searchParams.set("firm", firmId);
      let body: unknown;
      try {
        body = await withRetry(
          async () => {
            const headers = await deps.sign({ method: "GET", url, headers: { accept: "application/json" } });
            const response = await doFetch(url.href, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
            if (response.status === 404) throw new ToolError("NOT_FOUND", "the customs platform has no operation with that number for this firm", "PLATFORM_NOT_FOUND");
            if (!response.ok) throw new PlatformCallError(response.status, response.status === 429 || response.status >= 500);
            return (await response.json()) as unknown;
          },
          { attempts: deps.attempts ?? PLATFORM_ATTEMPTS, shouldRetry: isRetryableCall, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) },
        );
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("UNAVAILABLE", "the customs platform did not answer, try again later", "PLATFORM_UNAVAILABLE", { cause: error });
      }
      const parsed = PlatformOperation.safeParse(body);
      if (!parsed.success || parsed.data.firmId !== firmId || parsed.data.operationNumber !== number) {
        throw new ToolError("UNAVAILABLE", "the customs platform answered something that is not this operation", "PLATFORM_INVALID");
      }
      return parsed.data;
    },
  };
}

const FunctionUrlLink = z.object({ url: z.url() });

/** The platform of a Lambda that links `PlatformMock` (its Function URL and `MOCK_PLATFORM`). */
export function linkedPlatformClient(): PlatformOperations {
  return createPlatformClient({ endpoint: () => readLinked("PlatformMock", FunctionUrlLink).url, sign: sigV4Signer() });
}
