// `upload.presign` and `upload.done` (docs/tool-catalog.md): the driver acts as the importer's browser
// on `/u/<token>` of the public site, through CloudFront like any browser (no shortcut into
// `PublicWeb`), with the token of the last message that carried a link. A PDF is one of the model
// operation's template PDFs of the `Seed` bucket; the negative files declare what a browser would
// (`contentType`, `size`) so the page refuses them and audits `DENY UPLOAD_*` (FL-010).
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { type DocType, ToolError, seedKeys } from "@legajo/shared";
import { MAX_DOCUMENT_BYTES } from "../domain/documents";
import { awsClientConfig } from "../lib/clients";
import { bucketName } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { APP_ORIGIN } from "../public-web/deps";
import type { QaParsedInput } from "./contract-inputs";

const TIMEOUT_MS = 10_000;

const PresignAnswer = z.object({ ok: z.literal(true), url: z.url(), fields: z.record(z.string(), z.string()), key: z.string().min(1) }).loose();
const ErrorAnswer = z.object({ error: z.object({ code: z.string(), reason: z.string().optional() }).loose() }).loose();

export interface UploadDeps {
  readonly origin?: string;
  readonly fetch?: typeof fetch;
  /** Bytes of a template PDF (`Seed/pdfs/<templateOperation>/<docType>-v<n>.pdf`). */
  readonly seedPdf?: (templateOperation: string, docType: DocType, version: number) => Promise<Uint8Array>;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function s3SeedPdf(client?: S3Client) {
  let s3 = client;
  return async (templateOperation: string, docType: DocType, version: number): Promise<Uint8Array> => {
    s3 ??= new S3Client({ region: "us-east-1", ...awsClientConfig({ requestTimeoutMs: 10_000, connectionTimeoutMs: 1_000, maxAttempts: 3 }) });
    const object = await s3.send(new GetObjectCommand({ Bucket: bucketName("Seed"), Key: seedKeys.pdf(templateOperation, docType, version) }));
    if (object.Body === undefined) throw new ToolError("NOT_FOUND", `no template PDF ${docType} v${version} of ${templateOperation}`);
    return object.Body.transformToByteArray();
  };
}

export interface UploadOutcome {
  /** HTTP status of the page's answer (200 when it presigned or confirmed). */
  readonly status: number;
  /** Why the page refused (`NOT_PDF`, `TOO_LARGE`, `EXPIRED`…), when it did. */
  readonly refusal?: string;
  /** Object key the page issued (only for an accepted PDF). */
  readonly key?: string;
  /** Status S3 answered to the POST of the file. */
  readonly storageStatus?: number;
  /** S3's `<Code>`/`<Message>` when it refused the POST (no keys or signatures). */
  readonly storageError?: string;
}

async function postJson(doFetch: typeof fetch, url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

function refusalOf(json: unknown): string {
  const parsed = ErrorAnswer.safeParse(json);
  return parsed.success ? (parsed.data.error.reason ?? parsed.data.error.code) : "UNKNOWN";
}

export function browserUpload(deps: UploadDeps = {}) {
  const origin = deps.origin ?? APP_ORIGIN;
  const doFetch = deps.fetch ?? fetch;
  const seedPdf = deps.seedPdf ?? s3SeedPdf();
  const retry = <T>(run: () => Promise<T>) => withRetry(run, { attempts: 3, shouldRetry: (error) => error instanceof TypeError, ...(deps.sleep ? { sleep: deps.sleep } : {}) });

  return {
    async presign(token: string, file: QaParsedInput<"upload.presign">["file"], templateOperation: string): Promise<UploadOutcome> {
      const declared =
        file.kind === "pdf" ? undefined : file.kind === "notPdf" ? { contentType: "image/png", size: 2_048 } : { contentType: "application/pdf", size: MAX_DOCUMENT_BYTES + 1 };
      const bytes = file.kind === "pdf" ? await seedPdf(templateOperation, file.docType, file.version) : undefined;
      const body = { docType: file.docType, ...(declared ?? { contentType: "application/pdf", size: bytes?.byteLength ?? 0 }) };
      const answer = await retry(() => postJson(doFetch, `${origin}/u/${token}/presign`, body));
      if (answer.status !== 200) return { status: answer.status, refusal: refusalOf(answer.json) };
      const post = PresignAnswer.parse(answer.json);
      if (bytes === undefined) return { status: answer.status, key: post.key };
      const form = new FormData();
      for (const [name, value] of Object.entries(post.fields)) form.append(name, value);
      form.append("file", new Blob([bytes], { type: "application/pdf" }), `${file.docType.toLowerCase()}.pdf`);
      const stored = await retry(() => doFetch(post.url, { method: "POST", body: form, signal: AbortSignal.timeout(TIMEOUT_MS) }));
      if (stored.status < 300) return { status: answer.status, key: post.key, storageStatus: stored.status };
      const xml = await stored.text().catch(() => "");
      const code = /<Code>([^<]{0,80})<\/Code>/.exec(xml)?.[1] ?? "";
      const message = /<Message>([^<]{0,200})<\/Message>/.exec(xml)?.[1] ?? "";
      return { status: answer.status, key: post.key, storageStatus: stored.status, storageError: `${code} ${message}`.trim() };
    },

    async done(token: string, keys: readonly string[]): Promise<UploadOutcome> {
      const answer = await retry(() => postJson(doFetch, `${origin}/u/${token}/done`, { keys }));
      return answer.status === 200 ? { status: 200 } : { status: answer.status, refusal: refusalOf(answer.json) };
    },
  };
}

export type BrowserUpload = ReturnType<typeof browserUpload>;
