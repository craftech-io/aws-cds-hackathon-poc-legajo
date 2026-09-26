// HTTP edge of `PublicWeb` (Function URL behind the Router, payload format 2.0). The Router forwards
// the full path, so this module owns `/u/*`: the page `GET /u/<token>`, `POST /u/<token>/presign` and
// `POST /u/<token>/done`. Every response carries its own security headers (the console's response
// headers policy does not override them, docs/architecture.md §10), is never cached and sends no
// referrer, so the token in the path never reaches the storage endpoint or anybody else.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { z } from "zod";
import type { ErrorCode } from "@legajo/shared";

export const PUBLIC_WEB_PREFIX = "/u";

/** Largest JSON body the page sends ("Listo" with 20 keys stays far below). */
export const MAX_BODY_BYTES = 16 * 1024;

export type Route =
  | { readonly kind: "PAGE"; readonly token: string }
  | { readonly kind: "PRESIGN"; readonly token: string }
  | { readonly kind: "DONE"; readonly token: string }
  | { readonly kind: "NONE" };

const ACTIONS = { presign: "PRESIGN", done: "DONE" } as const;

/** `/u/<token>`, `/u/<token>/`, `/u/<token>/presign`, `/u/<token>/done`; anything else is `NONE`. */
export function routeOf(path: string): Route {
  const match = /^\/u\/([^/]+)(?:\/([a-z]+))?\/?$/.exec(path);
  if (!match) return { kind: "NONE" };
  const token = match[1] ?? "";
  const action = match[2];
  if (action === undefined) return { kind: "PAGE", token };
  const kind = (ACTIONS as Readonly<Record<string, "PRESIGN" | "DONE">>)[action];
  return kind === undefined ? { kind: "NONE" } : { kind, token };
}

export interface PublicRequest {
  readonly method: string;
  readonly path: string;
  /** Lower-case header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly requestId: string;
}

export function requestOf(event: APIGatewayProxyEventV2): PublicRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== undefined) headers[name.toLowerCase()] = value;
  const raw = event.body ?? "";
  return {
    method: event.requestContext.http.method.toUpperCase(),
    path: event.rawPath,
    headers,
    body: event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw,
    requestId: event.requestContext.requestId,
  };
}

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const JSON_CSP = "default-src 'none'; frame-ancestors 'none'";

export function htmlResponse(statusCode: number, html: string, csp: string): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": csp }, body: html };
}

export function jsonResponse(statusCode: number, body: Readonly<Record<string, unknown>>, extra: Readonly<Record<string, string>> = {}): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { ...BASE_HEADERS, ...extra, "content-type": "application/json; charset=utf-8", "content-security-policy": JSON_CSP }, body: JSON.stringify(body) };
}

/** `{ ok: false, error: { code, reason } }`: the page picks its message by status and reason, never by text. */
export function jsonError(statusCode: number, code: ErrorCode, reason: string, extra: Readonly<Record<string, string>> = {}): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(statusCode, { ok: false, error: { code, reason } }, extra);
}

/**
 * A POST of the page must come from the page: JSON (a cross-site form cannot send it without a CORS
 * preflight, and this function answers none) and, when the browser says where it comes from, from
 * the app's own origin. Calls without `Origin` (the QaDriver acting as the browser) are allowed: the
 * token is the credential either way.
 */
export function refusalOfPost(request: PublicRequest, appOrigin: string): "NOT_JSON" | "CROSS_SITE" | undefined {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json\s*(?:;|$)/i.test(contentType)) return "NOT_JSON";
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== appOrigin) return "CROSS_SITE";
  if (request.headers["sec-fetch-site"] === "cross-site") return "CROSS_SITE";
  return undefined;
}

export type BodyResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: "TOO_LARGE" | "NOT_JSON" | "INVALID" };

/** Size cap, JSON and the zod schema (strict: an unknown key is refused, not ignored). */
export function parseBody<T>(request: PublicRequest, schema: z.ZodType<T>): BodyResult<T> {
  if (Buffer.byteLength(request.body, "utf8") > MAX_BODY_BYTES) return { ok: false, reason: "TOO_LARGE" };
  let raw: unknown;
  try {
    raw = JSON.parse(request.body);
  } catch {
    return { ok: false, reason: "NOT_JSON" };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: "INVALID" };
}
