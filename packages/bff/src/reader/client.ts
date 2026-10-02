// The one client of the external document reader (ADR-0003, docs/architecture-integrations.md §5):
// every caller (intake in the worker, `read_document`, the QaDriver's probes) reads through it.
//
//   - Requests and answers are validated with the contract's zod schemas (@legajo/reader-contract).
//   - Signed with SigV4 (reader/signer.ts); `Idempotency-Key` = the `docVersionId` being read.
//   - `X-Fault-Scope: <clockId>` only for operations of a `qa-*` clock, so a scenario's faults never
//     reach a demo or guest world.
//   - 8 s per attempt; 3 retries with exponential backoff and full jitter on 429, 502, 503, 504,
//     timeouts and network errors, never earlier than `Retry-After`. A `Retry-After` longer than a
//     Lambda can wait ends the call at once: the intake's `TIMER#READER_RETRY` takes over.
//   - Retries exhausted → `ReaderError("READER_UNAVAILABLE")`: never an invented reading (FL-096).
//
// The source URL is never logged: its query carries a signature.
import {
  CreateReadingRequest,
  Health,
  IdempotencyKey,
  READER_HEADERS,
  READER_OPERATIONS,
  Reading,
  ReaderErrorBody,
  ReadingIdParam,
  readingPath,
  type ReaderOperationName,
  type ReadingHints,
} from "@legajo/reader-contract";
import { ClockId, DocVersionId, clockScopeOf } from "@legajo/shared";
import type { z } from "zod";
import { DeadlineError, withDeadline } from "../lib/deadline";
import { createLogger, type LogFields, type Logger } from "../lib/log";
import { backoffDelayMs } from "../lib/retry";
import { ReaderError, type ReaderFailureCode } from "./errors";
import type { RequestSigner } from "./signer";

/** Schemas the client validates with; `npm run reader:contract` compares them with the YAML. */
export const READER_CLIENT_SCHEMAS = { CreateReadingRequest, Reading, Health, Error: ReaderErrorBody } as const;

export const READER_CLIENT_DEFAULTS = {
  timeoutMs: 8_000,
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  /** Longest `Retry-After` worth waiting for inside one invocation. */
  maxRetryAfterMs: 5_000,
} as const;

export type ReaderFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: "error" },
) => Promise<Response>;

export interface ReaderClientDeps {
  /** Base URL of the reader (the Function URL of `ReaderMock` in the stage). */
  readonly endpoint: string;
  readonly sign: RequestSigner;
  readonly fetch?: ReaderFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Real time, only to read a `Retry-After` given as an HTTP date. */
  readonly nowMs?: () => number;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxRetryAfterMs?: number;
}

export interface CreateReadingInput {
  /** The document version being read; also the `Idempotency-Key`. */
  readonly docVersionId: string;
  readonly sha256: string;
  /** Pre-signed GET of the version in `Documents` (reader/source-url.ts). */
  readonly sourceUrl: string;
  /** Clock of the operation: decides whether `X-Fault-Scope` is sent. */
  readonly clockId: string;
  readonly hints?: ReadingHints;
}

export interface ReaderClient {
  createReading(input: CreateReadingInput): Promise<Reading>;
  getReading(readingId: string): Promise<Reading>;
  health(): Promise<Health>;
}

interface WireRequest {
  readonly operation: ReaderOperationName;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly context?: LogFields;
}

type Attempt = { readonly kind: "response"; readonly status: number; readonly text: string; readonly retryAfter: string | null } | { readonly kind: "transport"; readonly reason: "TIMEOUT" | "NETWORK" };

interface Verdict {
  readonly retryable: boolean;
  readonly code: ReaderFailureCode;
  readonly reason: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const FINAL_STATUS: Readonly<Record<number, ReaderFailureCode>> = { 400: "INVALID_REQUEST", 404: "NOT_FOUND", 413: "FILE_TOO_LARGE" };

/** `Retry-After` in milliseconds: delta-seconds or an HTTP date; undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

export function createReaderClient(deps: ReaderClientDeps): ReaderClient {
  const settings = {
    timeoutMs: deps.timeoutMs ?? READER_CLIENT_DEFAULTS.timeoutMs,
    maxRetries: deps.maxRetries ?? READER_CLIENT_DEFAULTS.maxRetries,
    baseDelayMs: deps.baseDelayMs ?? READER_CLIENT_DEFAULTS.baseDelayMs,
    maxDelayMs: deps.maxDelayMs ?? READER_CLIENT_DEFAULTS.maxDelayMs,
    maxRetryAfterMs: deps.maxRetryAfterMs ?? READER_CLIENT_DEFAULTS.maxRetryAfterMs,
  };
  const doFetch: ReaderFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const logger = deps.logger ?? createLogger({ bindings: { component: "reader-client" } });

  async function attempt(request: WireRequest): Promise<Attempt> {
    const spec = READER_OPERATIONS[request.operation];
    const url = new URL(request.path, deps.endpoint);
    const headers: Record<string, string> = { accept: "application/json", ...request.headers };
    if (request.body !== undefined) headers["content-type"] = "application/json";
    let signed: Record<string, string>;
    try {
      signed = await deps.sign({ method: spec.method, url, headers, body: request.body });
    } catch (error) {
      throw new ReaderError("READER_UNAVAILABLE", "could not sign the reader request", { attempts: 0 }, { cause: error });
    }
    // The host header is the URL's own; fetch sets it and refuses to take it from the caller.
    const sendHeaders = Object.fromEntries(Object.entries(signed).filter(([name]) => name.toLowerCase() !== "host"));
    try {
      return await withDeadline(`reader.${request.operation}`, settings.timeoutMs, async (signal) => {
        const response = await doFetch(url.toString(), { method: spec.method.toUpperCase(), headers: sendHeaders, body: request.body, signal, redirect: "error" });
        return { kind: "response", status: response.status, text: await response.text(), retryAfter: response.headers.get(READER_HEADERS.retryAfter) };
      });
    } catch (error) {
      return { kind: "transport", reason: error instanceof DeadlineError ? "TIMEOUT" : "NETWORK" };
    }
  }

  function verdictOf(outcome: Attempt): Verdict {
    if (outcome.kind === "transport") return { retryable: true, code: "READER_UNAVAILABLE", reason: outcome.reason };
    const retryAfterMs = parseRetryAfter(outcome.retryAfter, nowMs());
    if (RETRYABLE_STATUS.has(outcome.status)) return { retryable: true, code: "READER_UNAVAILABLE", reason: `HTTP_${outcome.status}`, status: outcome.status, retryAfterMs };
    return { retryable: false, code: FINAL_STATUS[outcome.status] ?? "READER_UNAVAILABLE", reason: `HTTP_${outcome.status}`, status: outcome.status };
  }

  function parseOk<T>(text: string, schema: z.ZodType<T>, attempts: number, log: Logger): T {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    log.error("reader answered outside its contract", { metric: "ReaderErrors", attempts, reason: "INVALID_RESPONSE" });
    throw new ReaderError("INVALID_RESPONSE", "the reader answered outside its contract", { attempts, status: 200 }, { cause: parsed.error });
  }

  async function call<T>(request: WireRequest, schema: z.ZodType<T>): Promise<T> {
    const log = logger.child({ operation: request.operation, ...request.context });
    let last: Verdict | undefined;
    let attempts = 0;
    while (attempts <= settings.maxRetries) {
      const outcome = await attempt(request);
      attempts += 1;
      if (outcome.kind === "response" && outcome.status === 200) return parseOk(outcome.text, schema, attempts, log);
      const verdict = verdictOf(outcome);
      log.warn("reader attempt failed", { attempt: attempts, status: verdict.status, reason: verdict.reason, retryable: verdict.retryable });
      if (!verdict.retryable) throw new ReaderError(verdict.code, `the reader answered ${verdict.reason}`, { attempts, status: verdict.status });
      last = verdict;
      const waitAtLeast = verdict.retryAfterMs ?? 0;
      if (attempts > settings.maxRetries || waitAtLeast > settings.maxRetryAfterMs) break;
      const delayMs = Math.max(backoffDelayMs(attempts - 1, { baseDelayMs: settings.baseDelayMs, maxDelayMs: settings.maxDelayMs, random: deps.random }), waitAtLeast);
      await sleep(delayMs);
    }
    log.error("reader unavailable", { metric: "ReaderErrors", attempts, status: last?.status, reason: last?.reason });
    const details = { attempts, status: last?.status, retryAfterMs: last?.retryAfterMs };
    throw new ReaderError("READER_UNAVAILABLE", "the document reader did not answer after retries", details);
  }

  return {
    async createReading(input) {
      const docVersionId = IdempotencyKey.parse(DocVersionId.parse(input.docVersionId));
      const clockId = ClockId.parse(input.clockId);
      const body = CreateReadingRequest.parse({ source: { url: input.sourceUrl }, sha256: input.sha256, hints: input.hints });
      const headers: Record<string, string> = { [READER_HEADERS.idempotencyKey.toLowerCase()]: docVersionId };
      if (clockScopeOf(clockId) === "QA") headers[READER_HEADERS.faultScope.toLowerCase()] = clockId;
      const path = READER_OPERATIONS.createReading.path;
      return call({ operation: "createReading", path, headers, body: JSON.stringify(body), context: { docVersionId } }, Reading);
    },
    async getReading(readingId) {
      return call({ operation: "getReading", path: readingPath(ReadingIdParam.parse(readingId)) }, Reading);
    },
    async health() {
      return call({ operation: "health", path: READER_OPERATIONS.health.path }, Health);
    },
  };
}
