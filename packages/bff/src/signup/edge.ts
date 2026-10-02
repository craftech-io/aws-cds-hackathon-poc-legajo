// The first step of every route of `Bff` (ADR-0015 §3.1), before the JWT is verified or a procedure is
// routed: the request must carry the distribution's `X-Origin-Verify` (403 otherwise), and a request
// that names a `signup.*` procedure must name only it, without `batch` and without an encoded path (400
// otherwise), so a sign-up can never hide behind another call from WAF's rules. `PublicWeb` applies
// the same origin check (public-web/handler.ts).
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { type HeaderMap, isOriginVerified } from "../lib/viewer-ip";
import { linkedSecret } from "./deps";

export interface EdgeGuard {
  /** The value CloudFront adds to every origin request (`OriginVerifyKey`); read per request, cached by the link reader. */
  readonly originVerifyKey: () => string;
}

/** The Lambdas' guard: the linked `OriginVerifyKey` secret. */
export const lambdaEdgeGuard: EdgeGuard = { originVerifyKey: () => linkedSecret("OriginVerifyKey") };

export const SIGNUP_PREFIX = "signup.";

export interface RouteFacts {
  /** Procedures the path names, decoded (`a,b` of a batch is two). */
  readonly procedures: readonly string[];
  /** The path carried percent-encoding beyond the commas of a batch. */
  readonly encoded: boolean;
  /** `?batch=` is present. */
  readonly batch: boolean;
}

/** `/api/account.usage,signup.start?batch=1` → its procedures and how it asked for them. */
export function routeFacts(rawPath: string, rawQueryString: string | undefined, queryParameters?: Readonly<Record<string, string | undefined>>): RouteFacts {
  const path = rawPath.replace(/^\/api(?=\/|$)/, "").replace(/^\//, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  const query = new URLSearchParams(rawQueryString ?? "");
  const batch = query.has("batch") || queryParameters?.batch !== undefined;
  return { procedures: decoded.split(","), encoded: decoded !== path.replaceAll("%2C", ",").replaceAll("%2c", ","), batch };
}

/** A route that names a sign-up procedure anywhere but alone, plainly and without `batch`. */
export function hidesSignup(facts: RouteFacts): boolean {
  const names = facts.procedures.map((name) => name.trim().toLowerCase());
  if (!names.some((name) => name.includes(SIGNUP_PREFIX))) return false;
  return names.length > 1 || facts.batch || facts.encoded;
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

/** The refusal before tRPC: same envelope shape as a tRPC error, so the console reads `data.reason`. */
export function edgeRefusal(statusCode: 400 | 403 | 503, reason: "ORIGIN_NOT_VERIFIED" | "BATCH_NOT_ALLOWED" | "UNAVAILABLE"): APIGatewayProxyStructuredResultV2 {
  const code = statusCode === 403 ? "FORBIDDEN" : statusCode === 400 ? "BAD_REQUEST" : "SERVICE_UNAVAILABLE";
  return { statusCode, headers: { ...JSON_HEADERS }, body: JSON.stringify({ error: { message: "request refused", code: -32600, data: { code, httpStatus: statusCode, reason } } }) };
}

/** The checks of the first step; `undefined` when the request may go on. */
export function edgeCheck(guard: EdgeGuard, headers: HeaderMap, facts: RouteFacts): APIGatewayProxyStructuredResultV2 | undefined {
  let expected: string;
  try {
    expected = guard.originVerifyKey();
  } catch {
    return edgeRefusal(503, "UNAVAILABLE");
  }
  if (!isOriginVerified(headers, expected)) return edgeRefusal(403, "ORIGIN_NOT_VERIFIED");
  if (hidesSignup(facts)) return edgeRefusal(400, "BATCH_NOT_ALLOWED");
  return undefined;
}
