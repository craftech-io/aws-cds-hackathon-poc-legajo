// Test support for public-web/: the demo world of the in-memory connector with its paused clock and an
// upload link of operation 4471, Function URL events as the Router forwards them, a presigner with
// fixed credentials (presigning is local, nothing leaves the machine) and a captured log. Not imported
// by runtime code.
import { S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { CLOCK, FIRM, REAL_NOW, START_SIM, memoryStores, seedDemoSlice } from "../connector/testing";
import type { MemoryStores } from "../connector/index";
import type { NewEntity } from "../domain/common";
import type { UploadLink } from "../domain/runtime";
import { createLogger } from "../lib/log";
import { APP_ORIGIN } from "./deps";
import { type PublicWebDeps, type PublicWebHandler, createPublicWebHandler } from "./handler";
import { s3PdfPresigner } from "./presign";
import { edgeHeaders, testEdgeGuard } from "../signup/testing";

/** A 32-byte base64url token, as `newPublicToken` makes them. */
export const TOKEN = "Zq3v9Kf0mX2bR7wLpT4yNc8hJd1sGa6eUo5iQkVxWtY";
export const OTHER_TOKEN = "Bn7Gm2Qx9Lr4Vt1Kc6Hp3Wz8Jd0Fs5Ay_Ue-Io2RqXe";
export const BUCKET = "legajo-poc-uploads-776805327629";
export const OPERATION_ID = "op-4471";
export const IN_72_HOURS = new Date(Date.parse(REAL_NOW) + 72 * 3_600_000).toISOString();

export { CLOCK, FIRM, REAL_NOW, START_SIM };

export interface PublicWebWorld {
  readonly stores: MemoryStores;
  readonly handler: PublicWebHandler;
  readonly deps: PublicWebDeps;
  /** Every log line the handler wrote, parsed. */
  readonly logs: () => Array<Record<string, unknown>>;
}

export interface WorldOptions {
  readonly now?: string;
  readonly deps?: Partial<PublicWebDeps>;
}

/** Demo world (firm-delta, op-4471 and its parties) with the clock paused at 14/10 10:30. */
export async function publicWebWorld(options: WorldOptions = {}): Promise<PublicWebWorld> {
  const stores = memoryStores();
  await seedDemoSlice(stores);
  await stores.connector.world.createClock({ clockId: CLOCK, firmId: FIRM, mode: "PAUSED", pausedSimNow: START_SIM, startAtSim: START_SIM, worldEpoch: 1 });
  const lines: string[] = [];
  let uuid = 0;
  const deps: PublicWebDeps = {
    connector: stores.connector,
    presigner: s3PdfPresigner({ bucket: BUCKET, client: new S3Client({ region: "us-east-1", credentials: { accessKeyId: "AKIDTESTPUBLICWEB", secretAccessKey: "test-secret" } }) }),
    appOrigin: APP_ORIGIN,
    wallClock: () => new Date(options.now ?? REAL_NOW),
    newUuid: () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`,
    loggerFor: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => lines.push(line) }),
    ...options.deps,
  };
  return { stores, deps, handler: createPublicWebHandler(deps, testEdgeGuard), logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/** The link `create_upload_link` would write for the certificate and the packing list of 4471. */
export function linkFixture(overrides: Partial<NewEntity<typeof UploadLink>> = {}): NewEntity<typeof UploadLink> {
  return {
    token: TOKEN,
    operationId: OPERATION_ID,
    importerId: "imp-norpampa",
    firmId: FIRM,
    clockId: CLOCK,
    docTypes: ["CERTIFICATE_OF_ORIGIN", "PACKING_LIST"],
    createdAtReal: REAL_NOW,
    expiresAtReal: IN_72_HOURS,
    ...overrides,
  };
}

export async function putLink(world: PublicWebWorld, overrides: Partial<NewEntity<typeof UploadLink>> = {}): Promise<UploadLink> {
  return world.stores.connector.runtime.putUploadLink(linkFixture(overrides));
}

export interface EventOptions {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Send the body base64-encoded, as a Function URL does for some content types. */
  readonly base64?: boolean;
}

let requestSequence = 0;

export function publicEvent(method: string, path: string, options: EventOptions = {}): APIGatewayProxyEventV2 {
  const json = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  const headers = { ...edgeHeaders(), ...(json === undefined ? {} : { "content-type": "application/json", origin: APP_ORIGIN }), ...options.headers };
  requestSequence += 1;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers,
    isBase64Encoded: options.base64 === true,
    ...(json === undefined ? {} : { body: options.base64 === true ? Buffer.from(json, "utf8").toString("base64") : json }),
    requestContext: {
      accountId: "anonymous",
      apiId: "public-web-url",
      domainName: "public-web-url.lambda-url.us-east-1.on.aws",
      domainPrefix: "public-web-url",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "203.0.113.20", userAgent: "vitest" },
      requestId: `req-public-web-${requestSequence.toString().padStart(4, "0")}`,
      routeKey: "$default",
      stage: "$default",
      time: "26/Sep/2026:15:00:00 +0000",
      timeEpoch: Date.parse(REAL_NOW),
    },
  };
}

export function header(response: APIGatewayProxyStructuredResultV2, name: string): string | undefined {
  const value = response.headers?.[name];
  return value === undefined ? undefined : String(value);
}

export function jsonBody(response: APIGatewayProxyStructuredResultV2): Record<string, unknown> {
  return JSON.parse(response.body ?? "{}") as Record<string, unknown>;
}

export interface PresignAnswer {
  readonly url: string;
  readonly key: string;
  readonly fields: Record<string, string>;
}

export async function presignFor(world: PublicWebWorld, docType: string, token: string = TOKEN, extra: Record<string, unknown> = {}): Promise<APIGatewayProxyStructuredResultV2> {
  return world.handler(publicEvent("POST", `/u/${token}/presign`, { body: { docType, size: 48_213, contentType: "application/pdf", ...extra } }));
}

/** Presigns one document and returns what the page keeps (it would then POST the file to `url`). */
export async function uploadedKey(world: PublicWebWorld, docType: string): Promise<string> {
  const response = await presignFor(world, docType);
  if (response.statusCode !== 200) throw new Error(`presign answered ${String(response.statusCode)}`);
  return (jsonBody(response) as unknown as PresignAnswer).key;
}

export async function listo(world: PublicWebWorld, keys: readonly string[], token: string = TOKEN): Promise<APIGatewayProxyStructuredResultV2> {
  return world.handler(publicEvent("POST", `/u/${token}/done`, { body: { keys } }));
}

/** Decoded policy document of a presigned POST. */
export function policyOf(fields: Readonly<Record<string, string>>): { expiration: string; conditions: unknown[] } {
  return JSON.parse(Buffer.from(fields.Policy ?? "", "base64").toString("utf8")) as { expiration: string; conditions: unknown[] };
}
