// Transport-neutral request and response of the platform mock, and the helpers that turn bad input
// into the error body of api.ts. The Lambda (lambda.ts) maps a Function URL event onto
// `PlatformRequest`; the local flows and the UI server call the app with it directly.
import { z } from "zod";
import { ConnectorError } from "@legajo/shared";
import { MAX_BODY_BYTES, type PlatformConflictReason, type PlatformErrorBody, type PlatformErrorCode } from "./api";

export interface PlatformRequest {
  readonly method: string;
  /** Path and query, e.g. `/v1/operations/4471?firm=firm-delta`. */
  readonly url: string;
  /** Header names in lower case, as Function URLs deliver them. */
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  /** Id the transport already has for the request (the Function URL request id). */
  readonly requestId?: string;
}

export interface PlatformResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Seconds a caller waits before retrying a 503 (it retries with the same Idempotency-Key). */
export const RETRY_AFTER_SECONDS = 1;

const STATUS: Readonly<Record<PlatformErrorCode, number>> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  CONFLICT: 409,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class PlatformHttpError extends Error {
  override readonly name = "PlatformHttpError";
  constructor(
    readonly code: PlatformErrorCode,
    message: string,
    readonly reason?: PlatformConflictReason,
    readonly headers: Readonly<Record<string, string>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export function conflict(reason: PlatformConflictReason, message: string): PlatformHttpError {
  return new PlatformHttpError("CONFLICT", message, reason);
}

export function jsonResponse(status: number, payload: unknown, headers: Readonly<Record<string, string>> = {}): PlatformResponse {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    body: JSON.stringify(payload),
  };
}

export function errorResponse(error: PlatformHttpError): PlatformResponse {
  const body: PlatformErrorBody = {
    error: error.reason === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, reason: error.reason },
  };
  return jsonResponse(error.status, body, error.headers);
}

/**
 * Store and bus failures as HTTP: a moved version is the caller's conflict, a corrupt row is ours
 * (500), anything else from a dependency is temporary (503 with Retry-After).
 */
export function fromConnectorError(error: ConnectorError): PlatformHttpError {
  if (error.code === "CONFLICT") return conflict("VERSION_CONFLICT", "the operation changed at the same time; retry");
  if (error.code === "VALIDATION") return new PlatformHttpError("INTERNAL", "stored data is not valid", undefined, {}, { cause: error });
  if (error.code === "NOT_FOUND") return new PlatformHttpError("NOT_FOUND", "not found", undefined, {}, { cause: error });
  return new PlatformHttpError("UNAVAILABLE", "temporarily unavailable, retry later", undefined, { "retry-after": String(RETRY_AFTER_SECONDS) }, { cause: error });
}

/** Issue paths and messages only: an echo of the rejected values could carry anything. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

export function parseOrInvalid<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PlatformHttpError("INVALID_REQUEST", `invalid ${what}: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

/** The single value of a query parameter; absent or repeated is invalid. */
export function singleQueryValue(query: URLSearchParams, name: string): string {
  const values = query.getAll(name);
  if (values.length !== 1 || values[0] === undefined) throw new PlatformHttpError("INVALID_REQUEST", `query parameter "${name}" is required once`);
  return values[0];
}

/** A JSON object body within MAX_BODY_BYTES. */
export function jsonBody(request: PlatformRequest): unknown {
  const body = request.body ?? "";
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new PlatformHttpError("PAYLOAD_TOO_LARGE", `body larger than ${MAX_BODY_BYTES} bytes`);
  if (body.trim() === "") throw new PlatformHttpError("INVALID_REQUEST", "a JSON body is required");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new PlatformHttpError("INVALID_REQUEST", "the body is not valid JSON");
  }
}

export function headerValue(request: PlatformRequest, name: string): string | undefined {
  const headers = request.headers ?? {};
  const lowered = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lowered);
  return key === undefined ? undefined : headers[key];
}
