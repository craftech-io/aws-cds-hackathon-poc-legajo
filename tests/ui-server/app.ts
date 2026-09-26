// The back half of the local UI server (docs/test-plan.md §2, level UI): the real `appRouter` behind
// `/api`, the real `PublicWeb` handler behind `/u`, and the S3 emulator behind `/s3`, all over one
// in-memory world. Id tokens are checked by the BFF's real verifier against the JWKS the Playwright
// run hands in: this entry is the only place that pins a key set (`jwks` option of the verifier),
// never the Lambda (packages/bff/src/auth/no-jwks-override.test.ts). Nothing leaves the machine.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { createCognitoIdTokenVerifier } from "@legajo/bff/auth/jwt";
import { brokerLookupOf, createBrokerDirectory } from "@legajo/bff/auth/staff";
import { createMemoryStores, type MemoryStores } from "@legajo/bff/connector/index";
import { createLogger } from "@legajo/bff/lib/log";
import { createPublicWebHandler } from "@legajo/bff/public-web/handler";
import { s3PdfPresigner } from "@legajo/bff/public-web/presign";
import type { ContextDeps } from "@legajo/bff/routers/deps";
import { createHandler } from "@legajo/bff/routers/handler";
import { appRouter } from "@legajo/bff/routers/index";
import { seedConsoleWorld } from "@legajo/bff/routers/testing";
import { createContextFactory } from "@legajo/bff/routers/trpc";
import type { Context as LambdaContext } from "aws-lambda";
import type { Jwks } from "aws-jwt-verify/jwk";
import { functionUrlEvent, readBody, writeResult } from "./lambda-bridge";
import { EMULATOR_CREDENTIALS, EMULATOR_REGION, ObjectStore, verifyPost } from "./s3-emulator";

/** Buckets of the emulator, named like the stage's logical buckets. */
export const LOCAL_BUCKETS = { uploads: "uploads-local", documents: "documents-local", media: "media-local" } as const;

export interface UiAppOptions {
  /** `http://127.0.0.1:<port>`: the page, the API and the emulator share it. */
  readonly origin: string;
  /** Placeholder pool of the Vite build under test. */
  readonly pool: { readonly userPoolId: string; readonly clientId: string };
  /** Public half of the run's ephemeral key. */
  readonly jwks: Jwks;
  /** Real time; the machine clock unless a test fixes it. */
  readonly now?: () => Date;
}

export interface UiApp {
  readonly stores: MemoryStores;
  readonly objects: ObjectStore;
  /** Answers `/api`, `/u` and `/s3`; false for anything else (the caller hands it to Vite). */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

const LAMBDA_CONTEXT = { functionName: "ui-server", awsRequestId: "ui-server" } as unknown as LambdaContext;

function contextDeps(options: UiAppOptions, stores: MemoryStores, now: () => Date): ContextDeps {
  return {
    verifier: createCognitoIdTokenVerifier(options.pool, { jwks: options.jwks }),
    brokers: createBrokerDirectory(brokerLookupOf(stores.connector.firms), now),
    connector: stores.connector,
    totp: { isTotpEnabled: () => Promise.resolve(false) },
    documents: { sign: (key) => Promise.resolve(`${options.origin}/s3/${LOCAL_BUCKETS.documents}/${key}`) },
    whatsappMode: () => "simulated",
    health: [],
    wallClock: now,
    loggerFor: (correlationId) => createLogger({ correlationId, level: "warn", bindings: { service: "ui-server" } }),
  };
}

function emulatorClient(origin: string): S3Client {
  return new S3Client({ region: EMULATOR_REGION, endpoint: `${origin}/s3`, forcePathStyle: true, credentials: EMULATOR_CREDENTIALS });
}

async function handleS3(request: IncomingMessage, response: ServerResponse, objects: ObjectStore, now: Date): Promise<void> {
  const url = new URL(request.url ?? "/", "http://ui-server.local");
  const [bucket = "", ...keyParts] = url.pathname.replace(/^\/s3\//, "").split("/");
  if (request.method === "GET") {
    const object = objects.get(bucket, decodeURIComponent(keyParts.join("/")));
    if (object === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": object.contentType, "content-disposition": "attachment" }).end(Buffer.from(object.body));
    return;
  }
  if (request.method !== "POST" || keyParts.length > 0) {
    response.writeHead(405).end();
    return;
  }
  const body = await readBody(request);
  const form = await new Request(url, { method: "POST", headers: { "content-type": request.headers["content-type"] ?? "" }, body }).formData();
  const verdict = await verifyPost(form, bucket, now);
  if (!verdict.ok) {
    response.writeHead(verdict.status, { "content-type": "application/xml" }).end(`<Error><Code>${verdict.code}</Code></Error>`);
    return;
  }
  objects.put(verdict.object);
  response.writeHead(204).end();
}

export async function createUiApp(options: UiAppOptions): Promise<UiApp> {
  const now = options.now ?? (() => new Date());
  const stores = createMemoryStores({ now });
  await seedConsoleWorld(stores, { judgeWorld: true });
  const objects = new ObjectStore();
  const bff = createHandler(appRouter, createContextFactory(() => contextDeps(options, stores, now)));
  const publicWeb = createPublicWebHandler({
    connector: stores.connector,
    presigner: s3PdfPresigner({ bucket: LOCAL_BUCKETS.uploads, client: emulatorClient(options.origin), origin: options.origin }),
    appOrigin: options.origin,
    wallClock: now,
    newUuid: () => randomUUID(),
    loggerFor: (correlationId) => createLogger({ correlationId, level: "warn", bindings: { service: "ui-server-public-web" } }),
  });

  return {
    stores,
    objects,
    async handle(request, response) {
      const path = new URL(request.url ?? "/", "http://ui-server.local").pathname;
      if (path === "/api" || path.startsWith("/api/")) {
        writeResult(response, await bff(functionUrlEvent(request, await readBody(request)), LAMBDA_CONTEXT));
        return true;
      }
      if (path.startsWith("/u/")) {
        writeResult(response, await publicWeb(functionUrlEvent(request, await readBody(request))));
        return true;
      }
      if (path.startsWith("/s3/")) {
        await handleS3(request, response, objects, now());
        return true;
      }
      return false;
    },
  };
}
