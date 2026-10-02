// Entry of the local UI server that Playwright's console and public-surface projects start
// (packages/web/e2e/playwright.config.ts): Vite serves the web, and the back half (app.ts) answers
// `/api`, `/u` and `/s3` on the same origin, as the Router does in the stage, plus the routes that
// exist only here (the user pool's browser API and the test switches, auth/test-routes.ts).
// Configuration comes from the runner: the port, the placeholder pool of the build and the run's JWKS
// (never a key of a real pool). It listens on 127.0.0.1 only.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createUiApp } from "./app";

const JWKS_ENV = "E2E_JWKS";
const DEFAULT_PORT = 4180;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`the UI server needs ${name} (set by the Playwright config)`);
  return value;
}

async function main(): Promise<void> {
  const port = Number(process.env.E2E_UI_SERVER_PORT ?? DEFAULT_PORT);
  const origin = `http://127.0.0.1:${port}`;
  const app = await createUiApp({
    origin,
    pool: { userPoolId: required("VITE_COGNITO_USER_POOL_ID"), clientId: required("VITE_COGNITO_CLIENT_ID") },
    jwks: JSON.parse(required(JWKS_ENV)) as Parameters<typeof createUiApp>[0]["jwks"],
  });
  const vite = await createViteServer({
    root: fileURLToPath(new URL("../../packages/web", import.meta.url)),
    configFile: fileURLToPath(new URL("../../packages/web/vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
  const server = createServer((request, response) => {
    app
      .handle(request, response)
      .then((handled) => {
        if (!handled) vite.middlewares(request, response);
      })
      .catch((error: unknown) => {
        process.stderr.write(`ui-server: ${error instanceof Error ? error.name : "error"} on ${request.method ?? "?"} ${request.url ?? "?"}\n`);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  });
  server.listen(port, "127.0.0.1", () => process.stdout.write(`ui-server: ${origin}\n`));
}

void main();
