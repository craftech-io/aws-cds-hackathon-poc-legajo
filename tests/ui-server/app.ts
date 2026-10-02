// The back half of the local UI server (docs/test-plan.md §2 and §3, level UI): the real `appRouter`
// behind `/api`, the real `PublicWeb` handler behind `/u`, the S3 emulator behind `/s3`, all over one
// in-memory world, plus the sign-up: `signup.*` with `SignupDispatch` in process, `Leads` in memory,
// `LeadNotice` recorded, a user pool that runs the real Cognito triggers (tests/ui-server/auth/) and the
// stand-in of `account.ensureWorld` / `account.world` until WP-31 registers them. There is no WAF and
// no OAC here: this server adds what CloudFront would (`X-Origin-Verify`, a `CloudFront-Viewer-Address`)
// and checks `x-amz-content-sha256` when a request carries it, as Lambda does behind OAC. Id tokens are
// checked by the BFF's real verifier against the JWKS this entry pins (the Playwright run's key and the
// pool's own): only here, never in the Lambda (packages/bff/src/auth/no-jwks-override.test.ts).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { createCognitoIdTokenVerifier } from "@legajo/bff/auth/jwt";
import { brokerLookupOf, createBrokerDirectory } from "@legajo/bff/auth/staff";
import { createMemoryStores, type MemoryStores } from "@legajo/bff/connector/index";
import { createLogger } from "@legajo/bff/lib/log";
import { createPublicWebHandler } from "@legajo/bff/public-web/handler";
import { s3PdfPresigner } from "@legajo/bff/public-web/presign";
import { accountRouter } from "@legajo/bff/routers/account";
import type { ContextDeps } from "@legajo/bff/routers/deps";
import { createHandler } from "@legajo/bff/routers/handler";
import { appRouter } from "@legajo/bff/routers/index";
import { seedConsoleWorld } from "@legajo/bff/routers/testing";
import { createContextFactory, mergeRouters, router } from "@legajo/bff/routers/trpc";
import type { AnyTRPCRouter } from "@trpc/server";
import type { Context as LambdaContext } from "aws-lambda";
import type { Jwks } from "aws-jwt-verify/jwk";
import { type LocalAccess, createLocalAccess } from "./auth/access";
import { BrowserCognito } from "./auth/browser-api";
import { type GuestWorlds, createGuestWorlds } from "./auth/guest-world";
import { handleTestRoute } from "./auth/test-routes";
import { createTokenIssuer } from "./auth/token-issuer";
import { realPreToken } from "./auth/triggers";
import { functionUrlEvent, readBody, writeResult } from "./lambda-bridge";
import { EMULATOR_CREDENTIALS, EMULATOR_REGION, ObjectStore, verifyPost } from "./s3-emulator";

/** Buckets of the emulator, named like the stage's logical buckets. */
export const LOCAL_BUCKETS = { uploads: "uploads-local", documents: "documents-local", media: "media-local" } as const;

export interface UiAppOptions {
  /** `http://127.0.0.1:<port>`: the page, the API and the emulator share it. */
  readonly origin: string;
  /** Placeholder pool of the Vite build under test. */
  readonly pool: { readonly userPoolId: string; readonly clientId: string };
  /** Public half of the Playwright run's key (the sessions the specs plant). */
  readonly jwks: Jwks;
  /** Real time; the machine clock unless a test fixes it. */
  readonly now?: () => Date;
}

export interface UiApp {
  readonly stores: MemoryStores;
  readonly objects: ObjectStore;
  readonly access: LocalAccess;
  readonly cognito: BrowserCognito;
  readonly worlds: GuestWorlds;
  /** Answers `/api`, `/u`, `/s3` and the test-only routes; false for anything else (the caller hands it to Vite). */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

const LAMBDA_CONTEXT = { functionName: "ui-server", awsRequestId: "ui-server" } as unknown as LambdaContext;
const ORIGIN_VERIFY_HEADER = "x-origin-verify";
const VIEWER_ADDRESS_HEADER = "cloudfront-viewer-address";
const CONTENT_SHA256_HEADER = "x-amz-content-sha256";
/** Test-only: the viewer IP a spec wants CloudFront to report, so specs side by side do not share the sign-up's IP limits. */
const E2E_VIEWER_HEADER = "x-e2e-viewer-ip";
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function contextDeps(verifier: ContextDeps["verifier"], options: UiAppOptions, stores: MemoryStores, now: () => Date): ContextDeps {
  return {
    verifier,
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
  const form = await new Request(url, { method: "POST", headers: { "content-type": request.headers["content-type"] ?? "" }, body: new Uint8Array(body) }).formData();
  const verdict = await verifyPost(form, bucket, now);
  if (!verdict.ok) {
    response.writeHead(verdict.status, { "content-type": "application/xml" }).end(`<Error><Code>${verdict.code}</Code></Error>`);
    return;
  }
  objects.put(verdict.object);
  response.writeHead(204).end();
}

/** The console's router plus the stand-in of `account.ensureWorld`/`account.world` while the real ones are missing. */
function routerWith(worlds: GuestWorlds): AnyTRPCRouter {
  const procedures = appRouter._def.procedures as Readonly<Record<string, unknown>>;
  if ("account.ensureWorld" in procedures && "account.world" in procedures) return appRouter;
  return router({ ...appRouter._def.record, account: mergeRouters(accountRouter, worlds.router) });
}

/** What CloudFront adds behind the Router, and Lambda's check of a signed body (ADR-0015 §3.1). */
function edgeHeaders(request: IncomingMessage, body: Buffer, originKey: string): { readonly ok: boolean } {
  const claimed = request.headers[CONTENT_SHA256_HEADER];
  if (typeof claimed === "string" && claimed !== createHash("sha256").update(body).digest("hex")) return { ok: false };
  const asked = request.headers[E2E_VIEWER_HEADER];
  delete request.headers[E2E_VIEWER_HEADER];
  const ip = typeof asked === "string" && IPV4.test(asked) ? asked : (request.socket.remoteAddress ?? "127.0.0.1");
  request.headers[ORIGIN_VERIFY_HEADER] = originKey;
  request.headers[VIEWER_ADDRESS_HEADER] = `${ip}:${request.socket.remotePort ?? 50_000}`;
  return { ok: true };
}

export async function createUiApp(options: UiAppOptions): Promise<UiApp> {
  const now = options.now ?? (() => new Date());
  const stores = createMemoryStores({ now });
  await seedConsoleWorld(stores, { guestWorld: true });
  const objects = new ObjectStore();
  const issuer = createTokenIssuer(options.pool);
  const verifier = createCognitoIdTokenVerifier(options.pool, { jwks: { keys: [...options.jwks.keys, ...issuer.jwks.keys] } as Jwks });
  const access = createLocalAccess(stores, options.pool.userPoolId, options.origin, now);
  const cognito = new BrowserCognito(access.pool, issuer, realPreToken(stores, options.pool.userPoolId), now);
  const worlds = createGuestWorlds(stores, now);
  const originKey = randomBytes(32).toString("base64");
  const edge = { originVerifyKey: () => originKey };
  const bff = createHandler(
    routerWith(worlds),
    createContextFactory(
      () => contextDeps(verifier, options, stores, now),
      () => access.deps,
    ),
    edge,
  );
  const publicWeb = createPublicWebHandler(
    {
      connector: stores.connector,
      presigner: s3PdfPresigner({ bucket: LOCAL_BUCKETS.uploads, client: emulatorClient(options.origin), origin: options.origin }),
      appOrigin: options.origin,
      wallClock: now,
      newUuid: () => randomUUID(),
      loggerFor: (correlationId) => createLogger({ correlationId, level: "warn", bindings: { service: "ui-server-public-web" } }),
    },
    edge,
  );

  return {
    stores,
    objects,
    access,
    cognito,
    worlds,
    async handle(request, response) {
      const path = new URL(request.url ?? "/", "http://ui-server.local").pathname;
      if (path === "/api" || path.startsWith("/api/") || path.startsWith("/u/")) {
        const body = await readBody(request);
        if (!edgeHeaders(request, body, originKey).ok) {
          response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ message: "The provided body hash does not match" }));
          return true;
        }
        const event = functionUrlEvent(request, body);
        writeResult(response, path.startsWith("/u/") ? await publicWeb(event) : await bff(event, LAMBDA_CONTEXT));
        return true;
      }
      if (path.startsWith("/s3/")) {
        await handleS3(request, response, objects, now());
        return true;
      }
      return handleTestRoute(request, response, { cognito, access, worlds });
    },
  };
}
