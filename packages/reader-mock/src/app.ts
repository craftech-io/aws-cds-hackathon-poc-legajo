// The reader mock as a plain request → response function over its ports (catalog, download, PDF
// id, clock, randomness), so the Lambda handler, the unit tests and the local flows run the same
// code. Order of `POST /v1/readings` (docs/architecture-integrations.md §5):
//
//   1. faults of the caller's QA world (`X-Fault-Scope`), before anything else
//   2. `Idempotency-Key` and body against the contract
//   3. the source URL must be a pre-signed GET of `Documents` → otherwise 400, nothing downloaded
//   4. idempotency cache by (key, SHA-256), 48 h
//   5. download (10 MB, 5 s) and SHA-256 check against the one sent
//   6. catalog by SHA-256, then by the embedded `LegajoDocId`, else UNRECOGNIZED
import { createHash } from "node:crypto";
import {
  CreateReadingRequest,
  Health,
  IdempotencyKey,
  READER_HEADERS,
  READER_OPERATIONS,
  Reading,
  ReaderErrorBody,
  ReadingIdParam,
  type ReaderErrorCode,
} from "@legajo/reader-contract";
import { idempotencyItem, type CatalogStore } from "./catalog";
import { FAULT_RETRY_AFTER_SECONDS, faultFor, type FaultEffect } from "./faults";
import { embeddedDocId } from "./pdf-meta";
import { READER_MOCK_VERSION, composeReading, parseReadingId, readingIdOf, type Match } from "./reading";
import { documentsSourceUrl, downloadSource, type DownloadFailure, type SourceFetch } from "./source";

/** Schemas the mock validates its input and output with; `npm run reader:contract` compares them with the YAML. */
export const READER_MOCK_SCHEMAS = { CreateReadingRequest, Reading, Health, Error: ReaderErrorBody } as const;

export interface ReaderHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
}

export interface ReaderHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** One line per request for the handler's log: ids and outcomes, never the URL or the body. */
export interface ReaderEvent {
  readonly operation: "createReading" | "getReading" | "health" | "unknown";
  readonly status: number;
  readonly matchedBy?: Match["by"];
  readonly cached?: boolean;
  readonly fault?: string;
  readonly reason?: string;
}

export interface ReaderAppDeps {
  readonly catalog: CatalogStore;
  /** Physical name of the stage's `Documents` bucket, the only source the mock downloads from. */
  readonly documentsBucket: string;
  readonly fetchSource?: SourceFetch;
  readonly extractDocId?: (bytes: Uint8Array) => Promise<string | undefined>;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onEvent?: (event: ReaderEvent) => void;
}

const MAX_BODY_CHARS = 16_384;
/** `Retry-After` of an unexpected failure (catalog unreachable, malformed item). */
const INTERNAL_RETRY_AFTER_SECONDS = 2;

const STATUS_OF: Readonly<Record<ReaderErrorCode, number>> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  FILE_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};

const DOWNLOAD_ERROR: Readonly<Record<DownloadFailure, { code: ReaderErrorCode; message: string }>> = {
  TOO_LARGE: { code: "FILE_TOO_LARGE", message: "file larger than 10 MB" },
  NOT_RETRIEVABLE: { code: "INVALID_REQUEST", message: "source URL could not be retrieved" },
  TIMEOUT: { code: "UNAVAILABLE", message: "source download timed out" },
  UNREACHABLE: { code: "UNAVAILABLE", message: "source could not be reached" },
};

function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): ReaderHttpResponse {
  return { statusCode, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

function failure(code: ReaderErrorCode, message: string, retryAfterSeconds?: number): ReaderHttpResponse {
  const headers: Record<string, string> = retryAfterSeconds === undefined ? {} : { [READER_HEADERS.retryAfter]: String(retryAfterSeconds) };
  return json(STATUS_OF[code], ReaderErrorBody.parse({ code, message }), headers);
}

function header(request: ReaderHttpRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

function parseBody(body: string | undefined): unknown {
  if (body === undefined || body.length > MAX_BODY_CHARS) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function createReaderApp(deps: ReaderAppDeps): (request: ReaderHttpRequest) => Promise<ReaderHttpResponse> {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const extractDocId = deps.extractDocId ?? embeddedDocId;
  const emit = deps.onEvent ?? (() => undefined);

  async function match(bytes: Uint8Array, sha256: string): Promise<Match> {
    const bySha = await deps.catalog.groundTruth({ sha256 });
    if (bySha !== undefined) return { by: "SHA256", truth: bySha };
    const docId = await extractDocId(bytes);
    const byId = docId === undefined ? undefined : await deps.catalog.groundTruth({ docId });
    return byId === undefined ? { by: "NONE" } : { by: "EMBEDDED_ID", truth: byId };
  }

  async function applyFault(effect: FaultEffect): Promise<ReaderHttpResponse | undefined> {
    if (effect.kind === "none") return undefined;
    if (effect.ms > 0) await sleep(effect.ms);
    if (effect.kind === "delay") return undefined;
    const code = effect.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE";
    return failure(code, `injected fault ${effect.mode}`, FAULT_RETRY_AFTER_SECONDS);
  }

  async function createReading(request: ReaderHttpRequest): Promise<ReaderHttpResponse> {
    const done = (response: ReaderHttpResponse, extra: Omit<ReaderEvent, "operation" | "status">): ReaderHttpResponse => {
      emit({ operation: "createReading", status: response.statusCode, ...extra });
      return response;
    };
    const effect = await faultFor(header(request, READER_HEADERS.faultScope), { catalog: deps.catalog, now: now(), random });
    const fault = effect.kind === "none" ? undefined : effect.mode;
    const injected = await applyFault(effect);
    if (injected !== undefined) return done(injected, { fault });

    const key = IdempotencyKey.safeParse(header(request, READER_HEADERS.idempotencyKey));
    if (!key.success) return done(failure("INVALID_REQUEST", "missing or invalid Idempotency-Key"), { fault, reason: "IDEMPOTENCY_KEY" });
    const body = CreateReadingRequest.safeParse(parseBody(request.body));
    if (!body.success) return done(failure("INVALID_REQUEST", "invalid request body"), { fault, reason: "BODY" });
    const url = documentsSourceUrl(body.data.source.url, deps.documentsBucket);
    if (url === undefined) return done(failure("INVALID_REQUEST", "source URL is not accepted"), { fault, reason: "SOURCE_URL" });

    const { sha256 } = body.data;
    const cached = await deps.catalog.cachedReading(key.data, sha256, now());
    if (cached !== undefined) return done(json(200, Reading.parse(cached.reading)), { fault, cached: true, matchedBy: cached.reading.matchedBy });

    const download = await downloadSource(url, { fetch: deps.fetchSource });
    if (!download.ok) {
      const error = DOWNLOAD_ERROR[download.reason];
      const retryAfter = error.code === "UNAVAILABLE" ? INTERNAL_RETRY_AFTER_SECONDS : undefined;
      return done(failure(error.code, error.message, retryAfter), { fault, reason: download.reason });
    }
    if (createHash("sha256").update(download.bytes).digest("hex") !== sha256) {
      return done(failure("INVALID_REQUEST", "SHA-256 of the file differs from the one sent"), { fault, reason: "SHA256_MISMATCH" });
    }

    const found = await match(download.bytes, sha256);
    const reading = Reading.parse(composeReading(readingIdOf(key.data, sha256), found));
    const stored = await deps.catalog.cacheReading(idempotencyItem(key.data, sha256, reading, now()));
    return done(json(200, Reading.parse(stored.reading)), { fault, cached: false, matchedBy: found.by });
  }

  async function getReading(rawId: string): Promise<ReaderHttpResponse> {
    let readingId: string;
    try {
      readingId = decodeURIComponent(rawId);
    } catch {
      return failure("NOT_FOUND", "unknown reading");
    }
    const ids = ReadingIdParam.safeParse(readingId).success ? parseReadingId(readingId) : undefined;
    const cached = ids === undefined ? undefined : await deps.catalog.cachedReading(ids.idempotencyKey, ids.sha256, now());
    return cached === undefined ? failure("NOT_FOUND", "unknown reading") : json(200, Reading.parse(cached.reading));
  }

  async function route(request: ReaderHttpRequest): Promise<ReaderHttpResponse> {
    const method = request.method.toLowerCase();
    const readingsPath = READER_OPERATIONS.createReading.path;
    if (method === READER_OPERATIONS.createReading.method && request.path === readingsPath) return createReading(request);
    if (method === READER_OPERATIONS.health.method && request.path === READER_OPERATIONS.health.path) {
      const response = json(200, Health.parse({ status: "ok", readerVersion: READER_MOCK_VERSION }));
      emit({ operation: "health", status: response.statusCode });
      return response;
    }
    const rest = request.path.startsWith(`${readingsPath}/`) ? request.path.slice(readingsPath.length + 1) : undefined;
    if (method === READER_OPERATIONS.getReading.method && rest !== undefined && rest !== "" && !rest.includes("/")) {
      const response = await getReading(rest);
      emit({ operation: "getReading", status: response.statusCode });
      return response;
    }
    emit({ operation: "unknown", status: 404 });
    return failure("NOT_FOUND", "unknown route");
  }

  return async (request) => {
    try {
      return await route(request);
    } catch (error) {
      emit({ operation: "unknown", status: 503, reason: error instanceof Error ? `INTERNAL:${error.name}` : "INTERNAL" });
      return failure("UNAVAILABLE", "reader temporarily unavailable", INTERNAL_RETRY_AFTER_SECONDS);
    }
  };
}
