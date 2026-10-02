// The local UI server's back half (tests/ui-server/app.ts: the real `appRouter`, the real `PublicWeb`
// handler and the S3 emulator over one in-memory world) on a free 127.0.0.1 port, for the landing's
// renders and captures and for e2e/public-upload.spec.ts, which need the world in their own process:
// they write upload links straight into it and read back what the page left behind. Tokens are
// verified against a key that exists only in this process. Nothing leaves the machine.
import { randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { TEST_POOL, type TestIssuer, createTestIssuer } from "@legajo/bff/auth/testing";
import type { UploadLink } from "@legajo/bff/domain/runtime";
import { linkFixture } from "@legajo/bff/public-web/testing";
import { type UiApp, createUiApp } from "../../tests/ui-server/app";

export interface LocalServer {
  /** `http://127.0.0.1:<port>`: the pages, the API and the S3 emulator share it. */
  readonly origin: string;
  readonly app: UiApp;
  /** Signs id tokens the BFF's real verifier accepts on this server (pool `TEST_POOL`). */
  readonly issuer: TestIssuer;
  close(): Promise<void>;
}

export type Fallback = (request: IncomingMessage, response: ServerResponse) => void;

export interface LocalServerOptions {
  /** Real time of the back half (fixed for the captures, so two runs show the same thing). */
  readonly now?: () => Date;
}

/** Starts the server; `fallback` answers what the back half does not (Vite, for the console). */
export async function startLocalServer(fallback?: Fallback, options: LocalServerOptions = {}): Promise<LocalServer> {
  const issuer = createTestIssuer({ kid: "landing-local" });
  let app: UiApp | undefined;
  const server = createServer((request, response) => {
    if (app === undefined) {
      response.writeHead(503).end();
      return;
    }
    app
      .handle(request, response)
      .then((handled) => {
        if (handled) return;
        if (fallback) fallback(request, response);
        else response.writeHead(404).end();
      })
      .catch((error: unknown) => {
        // The method and the error's name only: a request's path can carry an upload token.
        process.stderr.write(`local-server: ${error instanceof Error ? error.name : "error"} on a ${request.method ?? "?"} request\n`);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app = await createUiApp({ origin, pool: TEST_POOL, jwks: issuer.jwks, ...(options.now ? { now: options.now } : {}) });
  const ready = app;
  return {
    origin,
    app: ready,
    issuer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A browser keeps its connections alive; close them so the port is released now.
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** A fresh 32-byte token, as `create_upload_link` makes them. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface LinkOptions {
  /** Real time the link expires; 72 hours from now by default, as `create_upload_link` sets it. */
  readonly expiresAtReal?: Date;
  readonly docTypes?: UploadLink["docTypes"];
}

/** The upload link of operation 4471 that `create_upload_link` would write for its importer, created now. */
export async function newUploadLink(app: UiApp, options: LinkOptions = {}): Promise<UploadLink> {
  const now = Date.now();
  return app.stores.connector.runtime.putUploadLink(
    linkFixture({
      token: newToken(),
      createdAtReal: new Date(now).toISOString(),
      expiresAtReal: (options.expiresAtReal ?? new Date(now + 72 * 3_600_000)).toISOString(),
      ...(options.docTypes ? { docTypes: options.docTypes } : {}),
    }),
  );
}

/** A tiny synthetic PDF (the reader never sees it: nothing here runs the intake). */
export function syntheticPdf(bytes = 0): Buffer {
  const head = Buffer.from("%PDF-1.4\n% synthetic test document of Legajo listo\n");
  const tail = Buffer.from("\n%%EOF\n");
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length - tail.length), 0x20), tail]);
}
