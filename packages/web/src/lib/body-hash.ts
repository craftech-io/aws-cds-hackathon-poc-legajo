// SHA-256 of a request body for the `x-amz-content-sha256` header (ADR-0015 §3.1). Behind
// CloudFront's origin access control a Lambda Function URL refuses a body it cannot check, so every
// POST of the console and of the sign-up carries the hex digest of exactly the bytes it sends. WebCrypto
// only: nothing to download, and it runs the same in the browser, in Node and in the tests.

export const CONTENT_SHA256_HEADER = "x-amz-content-sha256";

type Body = string | ArrayBuffer | ArrayBufferView;

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesOf(body: Body | null | undefined): Uint8Array<ArrayBuffer> {
  if (body === null || body === undefined) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
}

/** Hex SHA-256 of `body` (the empty body hashes to the digest of zero bytes). */
export async function sha256Hex(body: Body | null | undefined): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytesOf(body)));
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function isHashable(body: unknown): body is Body | null | undefined {
  return body === null || body === undefined || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

/**
 * `init` with the body's digest in `x-amz-content-sha256` when the request has a body to sign (any
 * method but GET and HEAD). A body the console never sends (a stream, a form) is refused rather than
 * sent unsigned.
 */
export async function withBodyHash(input: RequestInfo | URL, init: RequestInit | undefined): Promise<RequestInit | undefined> {
  const method = methodOf(input, init);
  if (method === "GET" || method === "HEAD") return init;
  const body = init?.body;
  if (!isHashable(body)) throw new TypeError("only text and byte bodies can be signed");
  const headers = new Headers(init?.headers);
  headers.set(CONTENT_SHA256_HEADER, await sha256Hex(body));
  return { ...init, headers };
}
