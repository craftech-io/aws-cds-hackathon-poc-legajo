// The only file the mock ever downloads is a pre-signed GET of the stage's `Documents` bucket
// (docs/architecture-integrations.md §5, point 1). The URL is checked before any network call: https,
// the exact regional virtual-hosted host of that bucket, no port, no credentials in the authority and
// a key. The download follows no redirect, stops at 10 MB and 5 s, and never logs the URL (its query
// carries a signature).
import { READER_LIMITS, READER_SOURCE_REGION } from "@legajo/reader-contract";

export const SOURCE_TIMEOUT_MS = 5_000;

/** The parsed URL when it points into the `Documents` bucket, undefined for anything else. */
export function documentsSourceUrl(raw: string, documentsBucket: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = `${documentsBucket.toLowerCase()}.s3.${READER_SOURCE_REGION}.amazonaws.com`;
  if (documentsBucket === "" || url.protocol !== "https:" || url.hostname !== host) return undefined;
  if (url.port !== "" || url.username !== "" || url.password !== "") return undefined;
  if (url.pathname.length <= 1) return undefined;
  return url;
}

/**
 * `NOT_RETRIEVABLE`: S3 answered non-2xx (expired or foreign signature, missing key), the caller's
 * problem. `TIMEOUT` and `UNREACHABLE` (network error, unexpected redirect) are ours: worth a retry.
 */
export type DownloadFailure = "TOO_LARGE" | "NOT_RETRIEVABLE" | "TIMEOUT" | "UNREACHABLE";

export type DownloadResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: DownloadFailure };

export type SourceFetch = (url: URL, init: { readonly signal: AbortSignal; readonly redirect: "error" }) => Promise<Response>;

export interface DownloadOptions {
  readonly fetch?: SourceFetch;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Downloads a URL already accepted by `documentsSourceUrl`. */
export async function downloadSource(url: URL, options: DownloadOptions = {}): Promise<DownloadResult> {
  const doFetch: SourceFetch = options.fetch ?? ((target, init) => fetch(target, init));
  const maxBytes = options.maxBytes ?? READER_LIMITS.maxFileBytes;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? SOURCE_TIMEOUT_MS);
  try {
    const response = await doFetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, reason: "NOT_RETRIEVABLE" };
    }
    const bytes = await readCapped(response, maxBytes);
    return bytes === undefined ? { ok: false, reason: "TOO_LARGE" } : { ok: true, bytes };
  } catch {
    return { ok: false, reason: timedOut ? "TIMEOUT" : "UNREACHABLE" };
  } finally {
    clearTimeout(timer);
  }
}
