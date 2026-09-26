/// <reference path="../../../sst-env.d.ts" />
// Lambda entry of `ReaderMock` (Function URL with AWS_IAM; only `OperationWorker`, `ToolDocuments`
// and `QaDriver` may invoke it, docs/architecture.md §14). Linked resources, read through `Resource`
// and validated with zod (never `process.env`):
//
//   ReaderCatalog      the mock's own table (`name`)
//   ReaderMockConfig   `documentsBucket`: name of the stage's `Documents` bucket. A plain Linkable,
//                      not a link to the bucket: the mock downloads only through pre-signed URLs
//                      and holds no S3 permission of its own.
import type { LambdaFunctionURLResult } from "aws-lambda";
import { Resource } from "sst";
import { z } from "zod";
import { createReaderApp, type ReaderAppDeps, type ReaderEvent, type ReaderHttpRequest } from "./app";
import { catalogDocumentClient, createDynamoCatalog, documentSend } from "./dynamo-catalog";

/** The part of a Function URL event the mock uses (payload format 2.0). */
const FunctionUrlEvent = z.object({
  rawPath: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  isBase64Encoded: z.boolean().default(false),
  requestContext: z.object({ requestId: z.string(), http: z.object({ method: z.string() }) }),
});

const TableLink = z.object({ name: z.string().min(1) });
const ConfigLink = z.object({ documentsBucket: z.string().min(1) });

function linked<T>(logicalName: string, schema: z.ZodType<T>): T {
  // `Resource` is a Proxy that throws for anything not linked; zod checks the shape it returns.
  return schema.parse(Reflect.get(Resource, logicalName));
}

/** One JSON line per request, correlated by the Function URL request id; ids and outcomes only. */
function logEvent(correlationId: string, event: ReaderEvent): void {
  const line = { level: event.status >= 500 ? "warn" : "info", time: new Date().toISOString(), correlationId, message: "reader request", ...event };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

let deps: ReaderAppDeps | undefined;

function linkedDeps(): ReaderAppDeps {
  deps ??= {
    catalog: createDynamoCatalog(linked("ReaderCatalog", TableLink).name, documentSend(catalogDocumentClient())),
    documentsBucket: linked("ReaderMockConfig", ConfigLink).documentsBucket,
  };
  return deps;
}

/** Function URL event → contract request (the response goes back as is). */
export function toReaderRequest(raw: unknown): ReaderHttpRequest & { readonly correlationId: string } {
  const event = FunctionUrlEvent.parse(raw);
  const body = event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return { method: event.requestContext.http.method, path: event.rawPath, headers: event.headers, body, correlationId: event.requestContext.requestId };
}

export async function handler(event: unknown): Promise<LambdaFunctionURLResult> {
  const request = toReaderRequest(event);
  const app = createReaderApp({ ...linkedDeps(), onEvent: (readerEvent) => logEvent(request.correlationId, readerEvent) });
  const response = await app(request);
  return { statusCode: response.statusCode, headers: { ...response.headers }, body: response.body };
}
