// What `PublicWeb` uses in the Lambda, built once per container on the first request: the DynamoDB
// connector (`Runtime` and `AuditLog`), the presigner of the linked `Uploads` bucket (read through
// `Resource` by lib/resource.ts, never `process.env`) and real time. Capability row `PublicWeb` of
// infra/iam-capabilities.ts: Runtime and AuditLog write, Uploads write (the presigned PutObject).
import { randomUUID } from "node:crypto";
import { STAGE_DOMAIN } from "@legajo/shared";
import { connector } from "../connector/index";
import { createLogger } from "../lib/log";
import { bucketName } from "../lib/resource";
import type { PublicWebDeps } from "./handler";
import { s3PdfPresigner } from "./presign";

/** Origin of the page and of every POST the browser makes to it. */
export const APP_ORIGIN = `https://${STAGE_DOMAIN}`;

export function defaultPublicWebDeps(): PublicWebDeps {
  return {
    connector: connector(),
    presigner: s3PdfPresigner({ bucket: bucketName("Uploads") }),
    appOrigin: APP_ORIGIN,
    wallClock: () => new Date(),
    newUuid: () => randomUUID(),
    loggerFor: (correlationId) => createLogger({ correlationId, bindings: { service: "public-web" } }),
  };
}
