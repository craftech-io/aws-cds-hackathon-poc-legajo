// Test kit of the reader mock, for its own tests, the BFF client's and the local flows (tests/flows):
// a minimal PDF writer with an info dictionary, a fake `Documents` bucket behind pre-signed-looking
// URLs, and a `fetch` that runs a reader app in process. Never imported by the Lambda.
import { createHash } from "node:crypto";
import { READER_SOURCE_REGION } from "@legajo/reader-contract";
import type { ReaderHttpRequest, ReaderHttpResponse } from "./app";
import type { SourceFetch } from "./source";

function pdfString(value: string): string {
  return `(${value.replace(/[\\()]/g, (char) => `\\${char}`)})`;
}

/**
 * A one-page PDF 1.4 with the given info dictionary (`{ LegajoDocId: "LDOC-4471-PL-v1" }`) and
 * `extraObjects` empty objects to exercise the object cap. Byte offsets of the xref are exact.
 */
export function syntheticPdf(info: Readonly<Record<string, string>> = {}, options: { extraObjects?: number; text?: string } = {}): Uint8Array {
  const infoEntries = Object.entries(info)
    .map(([key, value]) => `/${key} ${pdfString(value)}`)
    .join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>`,
    `<< ${infoEntries} /Producer ${pdfString(options.text ?? "synthetic test document")} >>`,
    ...Array.from({ length: options.extraObjects ?? 0 }, () => "<< >>"),
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A URL of the shape S3 pre-signs for `Documents` (regional, virtual-hosted, with a query). */
export function documentsUrl(bucket: string, key: string): string {
  return `https://${bucket}.s3.${READER_SOURCE_REGION}.amazonaws.com/${key}?X-Amz-Expires=300&X-Amz-Signature=test`;
}

export interface FakeBucket {
  readonly fetch: SourceFetch;
  put(key: string, bytes: Uint8Array): void;
  /** Keys requested so far, in order. */
  readonly requested: string[];
}

/** Serves the objects put in it by key (the URL path), 403 for anything else. */
export function fakeDocumentsBucket(): FakeBucket {
  const objects = new Map<string, Uint8Array>();
  const requested: string[] = [];
  return {
    requested,
    put: (key, bytes) => objects.set(key, bytes),
    fetch: async (url) => {
      const key = decodeURIComponent(url.pathname.slice(1));
      requested.push(key);
      const bytes = objects.get(key);
      return bytes === undefined ? new Response("AccessDenied", { status: 403 }) : new Response(bytes.slice(), { status: 200, headers: { "content-length": String(bytes.byteLength) } });
    },
  };
}

export interface InProcessInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface RecordedRequest extends ReaderHttpRequest {
  readonly url: string;
}

/**
 * `fetch` that hands every request to a reader app in this process, as the Function URL would
 * (lower-case headers), and records it. An aborted signal rejects like a real `fetch`.
 */
export function inProcessReaderFetch(app: (request: ReaderHttpRequest) => Promise<ReaderHttpResponse>, recorded: RecordedRequest[] = []) {
  return async (url: string, init: InProcessInit): Promise<Response> => {
    const target = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value]));
    const request: RecordedRequest = { url, method: init.method, path: target.pathname, headers, body: init.body };
    recorded.push(request);
    const aborted = new Promise<never>((_resolve, reject) => {
      if (init.signal?.aborted) reject(init.signal.reason);
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    const response = await Promise.race([app(request), aborted]);
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
}
