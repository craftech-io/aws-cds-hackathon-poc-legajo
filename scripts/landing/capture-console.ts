// Console captures of the landing's gallery (status `capture` in public/landing/manifest.json), one per
// entry of scripts/landing/captures.json, at 1280x800 (docs/design-brief.md §7.2):
//
//   JUDGE_TEST_PASSWORD=… FORBIDDEN_TERMS=… npx tsx scripts/landing/capture-console.ts --target poc
//       the deployed stage (https://legajo.demo.craftech.io, or --base-url), signed in through the real
//       login as the synthetic `judge-test` account right after a real run of the guided tour (SC-24):
//       origin `poc`
//   FORBIDDEN_TERMS=… npx tsx scripts/landing/capture-console.ts --target local
//       the local UI server (Vite + the real appRouter over the in-memory world, local-server.ts) with a
//       session of the fictitious broker of Estudio Delta signed by a key of this process: origin
//       `local`, which the landing labels "entorno local, agente guionado"
//
//   --only console-audit,console-metrics   take only these
//   --out <dir>                            write the PNGs there and leave public/ untouched
//
// Fails closed without FORBIDDEN_TERMS. The password is read from the environment only and never
// printed. Every request outside the target (and, for `poc`, Cognito) is aborted and fails the run;
// the text of each frame is checked before it is written (frame-check.ts).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Page, chromium } from "@playwright/test";
import { TEST_POOL } from "@legajo/bff/auth/testing";
import { SUBS } from "@legajo/bff/routers/testing";
import { createServer as createViteServer } from "vite";
import { z } from "zod";
import { copy } from "../../packages/web/src/copy/console";
import { CONSOLE_CAPTURE_IDS, type CaptureOrigin, MediaId } from "../../packages/web/src/views/landing/manifest";
import { plantSessionScript } from "./console-session";
import { assertCleanFrame, termsFor } from "./frame-check";
import { startLocalServer } from "./local-server";
import { LANDING_DIR, WEB_DIR, recordInManifest, writePicture } from "./manifest-file";

const STAGE_URL = "https://legajo.demo.craftech.io";
const JUDGE_TEST_USER = "judge-test";
const PASSWORD_ENV = "JUDGE_TEST_PASSWORD";
const VIEWPORT = { width: 1280, height: 800 } as const;

const Capture = z.object({ view: z.string().startsWith("/app/"), open: z.string().optional(), moment: z.string().min(1) }).strict();
type Capture = z.infer<typeof Capture>;
const CapturesFile = z.object({ _readme: z.string(), captures: z.partialRecord(MediaId, Capture) }).strict();

interface Target {
  readonly origin: CaptureOrigin;
  /** Origin the console is served from. */
  readonly base: string;
  allowed(url: URL): boolean;
  signIn(page: Page): Promise<void>;
  close(): Promise<void>;
}

async function pocTarget(baseUrl: string): Promise<Target> {
  const password = process.env[PASSWORD_ENV];
  if (!password) throw new Error(`${PASSWORD_ENV} is not set: the judge-test password comes only from the environment`);
  const base = new URL(baseUrl).origin;
  return {
    origin: "poc",
    base,
    // The console signs in against Cognito and reads documents from S3 by pre-signed URL.
    allowed: (url) => url.origin === base || url.hostname.endsWith(".amazonaws.com"),
    async signIn(page) {
      // The sign-in form by its autocomplete roles: its labels pull the login's DOM-typed modules in.
      await page.goto(`${base}/login`);
      await page.locator('input[autocomplete="username"]').fill(JUDGE_TEST_USER);
      await page.locator('input[autocomplete="current-password"]').fill(password);
      await page.locator('form button[type="submit"]').click();
      await page.waitForURL(/\/app\//, { timeout: 90_000 });
    },
    close: () => Promise.resolve(),
  };
}

async function localTarget(): Promise<Target> {
  // The build under capture takes the planted session without asking Cognito for anything.
  Object.assign(process.env, { VITE_COGNITO_USER_POOL_ID: TEST_POOL.userPoolId, VITE_COGNITO_CLIENT_ID: TEST_POOL.clientId });
  const vite = await createViteServer({ root: WEB_DIR, configFile: join(WEB_DIR, "vite.config.ts"), logLevel: "warn", appType: "spa", server: { middlewareMode: true, hmr: false, ws: false } });
  const server = await startLocalServer((request, response) => vite.middlewares(request, response));
  const idToken = server.issuer.idToken({
    sub: SUBS.diego,
    "cognito:username": "brk-delta-diego",
    "cognito:groups": ["BROKER"],
    "custom:firmId": "firm-delta",
    "custom:role": "BROKER",
    name: "Diego Ferreyra",
    email: undefined,
  });
  return {
    origin: "local",
    base: server.origin,
    allowed: (url) => url.origin === server.origin,
    async signIn(page) {
      await page.addInitScript(plantSessionScript({ idToken, accessToken: "capture-only", expiresAt: Date.now() + 3_600_000 }));
    },
    async close() {
      await server.close();
      await vite.close();
    },
  };
}

/** The guided tour opens by itself for a judge; the captures show the view without it. */
async function closeTour(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: copy.tour.open, exact: true }).first();
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
}

async function frame(page: Page, target: Target, entry: Capture): Promise<void> {
  await page.goto(`${target.base}${entry.view}`);
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 60_000 });
  if (entry.open) {
    await page.getByRole("link", { name: new RegExp(`\\b${entry.open}\\b`) }).first().click();
    await page.waitForURL((url) => url.pathname !== entry.view, { timeout: 30_000 });
    await page.getByRole("heading", { level: 1 }).first().waitFor();
  }
  await closeTour(page);
  // The console polls every few seconds; a quiet half second is enough to settle what it shows.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
}

interface Options {
  readonly target: "poc" | "local";
  readonly baseUrl: string;
  readonly only: ReadonlySet<string> | undefined;
  readonly out: string | undefined;
}

function options(): Options {
  const { values } = parseArgs({ options: { target: { type: "string" }, "base-url": { type: "string" }, only: { type: "string" }, out: { type: "string" } } });
  if (values.target !== "poc" && values.target !== "local") throw new Error("--target poc|local is required");
  return {
    target: values.target,
    baseUrl: values["base-url"] ?? STAGE_URL,
    only: values.only ? new Set(values.only.split(",").map((id) => id.trim())) : undefined,
    out: values.out ? resolve(values.out) : undefined,
  };
}

async function main(): Promise<void> {
  const settings = options();
  const terms = termsFor(true);
  const captures = CapturesFile.parse(JSON.parse(readFileSync(join(import.meta.dirname, "captures.json"), "utf8"))).captures;
  const wanted = CONSOLE_CAPTURE_IDS.filter((id) => !settings.only || settings.only.has(id));
  if (wanted.length === 0) throw new Error("no capture matches --only");

  const target = settings.target === "poc" ? await pocTarget(settings.baseUrl) : await localTarget();
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome" });
  const escaped: string[] = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, locale: "es-AR", timezoneId: "America/Argentina/Buenos_Aires", colorScheme: "light", reducedMotion: "reduce" });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (target.allowed(url)) return route.continue();
      escaped.push(url.host);
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await target.signIn(page);
    for (const id of wanted) {
      const entry = captures[id];
      if (!entry) throw new Error(`${id} is not in scripts/landing/captures.json`);
      await frame(page, target, entry);
      if (escaped.length > 0) throw new Error(`${id}: the console tried to reach ${escaped.join(", ")}`);
      assertCleanFrame(id, await page.locator("body").innerText(), terms);
      const png = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
      const file = writePicture(settings.out ?? LANDING_DIR, id, png);
      if (!settings.out) recordInManifest(id, { file, width: VIEWPORT.width, height: VIEWPORT.height, status: "capture", origin: target.origin });
      process.stdout.write(`${id}.png  ${Math.round(png.byteLength / 1024)} KB  ${target.origin}  ${entry.view}\n`);
    }
  } finally {
    await browser.close();
    await target.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`capture-console: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
