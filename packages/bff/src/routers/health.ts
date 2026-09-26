// `GET /api/health`: the public probe of the console BFF (the interim smoke, `SC-00` step 3 and the
// catalog's `health` router, docs/tool-catalog.md). It carries no principal and no data: it says the
// function answers and whether the mocks it depends on answer to its role, starting with
// `GET /v1/health` of `PlatformMock` signed with SigV4 by the BFF's own role (capability
// `MOCK_PLATFORM`, docs/architecture-integrations.md §6, `SMK/3`).
//
// Being public, a probe must not turn into traffic the caller controls: each check keeps its last
// outcome for a while per container (`cachedHealthCheck`), so a burst of probes costs one call.
import { z } from "zod";
import { describeError } from "../auth/errors";
import type { Logger } from "../lib/log";
import { withRetry } from "../lib/retry";
import type { RequestSigner, SignableRequest } from "../reader/signer";

export interface HealthCheck {
  readonly name: string;
  /** Resolves when the dependency answers as expected; rejects otherwise. */
  run(): Promise<void>;
}

export const CheckStatus = z.enum(["ok", "unavailable"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

export interface HealthReport {
  readonly ok: boolean;
  readonly service: "bff";
  readonly checks: Readonly<Record<string, CheckStatus>>;
}

/** Runs every check in parallel; a failing check is logged by class and message only. */
export async function healthReport(checks: readonly HealthCheck[], log: Logger): Promise<HealthReport> {
  const outcomes = await Promise.all(
    checks.map(async (check): Promise<[string, CheckStatus]> => {
      try {
        await check.run();
        return [check.name, "ok"];
      } catch (error) {
        log.warn("console.health.check_failed", { check: check.name, ...describeError(error) });
        return [check.name, "unavailable"];
      }
    }),
  );
  return { ok: outcomes.every(([, status]) => status === "ok"), service: "bff", checks: Object.fromEntries(outcomes) };
}

/** The mocks answer `{ status: "ok" }` on `/v1/health` (packages/platform-mock/src/api.ts). */
const MockHealthBody = z.object({ status: z.literal("ok") });

export const HEALTH_PATH = "/v1/health";

export class HealthCheckError extends Error {
  override readonly name = "HealthCheckError";
  constructor(
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(`health endpoint answered HTTP ${status}`);
  }
}

export interface FunctionUrlHealthCheckOptions {
  readonly name: string;
  /** Function URL of the mock, read when the check runs: a missing link is an unhealthy check, not a crash. */
  readonly endpoint: () => string;
  readonly sign: RequestSigner;
  /** Test seam; the global `fetch` otherwise. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

// The probe answers in milliseconds; a slow one is as bad as a missing one.
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_ATTEMPTS = 2;

function isRetryableProbeError(error: unknown): boolean {
  if (error instanceof HealthCheckError) return error.retryable;
  // A network failure of `fetch` is a TypeError; a timed-out attempt is worth one more try.
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

/** `GET <Function URL>/v1/health` signed with SigV4 (service `lambda`), with timeout and backoff. */
export function functionUrlHealthCheck(options: FunctionUrlHealthCheckOptions): HealthCheck {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    name: options.name,
    async run() {
      // The assertion only matters to the infra program (infra/web-spec.test.ts imports the handler),
      // where SST's vendored @types/node merge a second global `URL` declaration into the type.
      const url = new URL(HEALTH_PATH, options.endpoint()) as SignableRequest["url"];
      await withRetry(
        async () => {
          const headers = await options.sign({ method: "GET", url, headers: { accept: "application/json" } });
          const response = await doFetch(url.href, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
          if (!response.ok) throw new HealthCheckError(response.status, response.status === 429 || response.status >= 500);
          MockHealthBody.parse(await response.json());
        },
        { attempts: options.attempts ?? DEFAULT_ATTEMPTS, shouldRetry: isRetryableProbeError, ...(options.sleep ? { sleep: options.sleep } : {}) },
      );
    },
  };
}

export interface CachedHealthCheckOptions {
  readonly ttlMs: number;
  /** Real time. */
  readonly now?: () => Date;
}

/** Keeps the last outcome of `check` (success or failure) for `ttlMs`; concurrent probes share one run. */
export function cachedHealthCheck(check: HealthCheck, options: CachedHealthCheckOptions): HealthCheck {
  const now = options.now ?? (() => new Date());
  let last: { readonly until: number; readonly outcome: Promise<void> } | undefined;
  return {
    name: check.name,
    run() {
      const at = now().getTime();
      if (last === undefined || last.until <= at) {
        const outcome = check.run();
        // The cached promise is awaited later; mark it handled so a failure is not reported twice.
        outcome.catch(() => undefined);
        last = { until: at + options.ttlMs, outcome };
      }
      return last.outcome;
    },
  };
}
