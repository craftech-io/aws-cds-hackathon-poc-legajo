// Console captures of the landing (ADR-0016 §4, docs/landing-spec.md §7.2 and §7.3), one per entry of
// scripts/landing/captures.json, in desktop 1440x900 and mobile 390x844 at 2x, with reduced motion,
// Buenos Aires time and the light theme:
//
//   GUEST_TEST_PASSWORD=… FORBIDDEN_TERMS=… npx tsx scripts/landing/capture-console.ts --target poc
//       https://legajo.demo.craftech.io only (or a subdomain, --base-url), signed in through the real
//       login as the synthetic `guest-test` account after a real run of the guided tour (SC-24):
//       origin `poc`, no label on the landing
//   FORBIDDEN_TERMS=… npx tsx scripts/landing/capture-console.ts --target local
//       the local UI server (Vite + the real appRouter over the in-memory world) loaded with each
//       entry's deterministic moment of the `guest` world (tests/ui-server/moments/), real time fixed
//       on the server and in the page: origin `local`, labelled "Entorno local, agente guionado"
//
//   --only console-audit,console-metrics   take only these
//   --out <dir>                            write raw PNGs there and leave public/ and the manifest untouched
//
// Fails closed without FORBIDDEN_TERMS. The password is read from the environment only and never
// printed. Every request outside the target is aborted and fails the run; the text of each frame is
// checked before it is written (frame-check.ts); the files are written by encode.ts and recorded in
// the manifest (manifest-file.ts).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, type BrowserContext, type Page, chromium } from "@playwright/test";
import { TEST_POOL } from "@legajo/bff/auth/testing";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { copy } from "../../packages/web/src/copy/console";
import { CONSOLE_CAPTURE_IDS, type ConsoleCaptureId, type Viewport } from "../../packages/web/src/views/landing/manifest";
import { CAPTURE_GUEST, MOMENT_IDS, type MomentId, loadMoment } from "../../tests/ui-server/moments/index";
import { type Capture, readCaptures } from "./captures";
import { localRequestAllowed, parseCaptureArgs, stageRequestAllowed } from "./capture-target";
import { plantSessionScript } from "./console-session";
import { encodePicture } from "./encode";
import { type ForbiddenTerm } from "../lint/forbidden-terms";
import { assertCleanFrame, termsFor } from "./frame-check";
import { startLocalServer } from "./local-server";
import { WEB_DIR, recordEntry } from "./manifest-file";

export const VIEWPORTS: Readonly<Record<Viewport, { readonly width: number; readonly height: number }>> = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
export const SCALE = 2;

/** Software raster in one pass, sRGB and no LCD text: the same page gives the same pixels every run. */
export const DETERMINISTIC_CHROME_ARGS = ["--force-color-profile=srgb", "--disable-gpu", "--disable-partial-raster", "--disable-skia-runtime-opts", "--disable-lcd-text", "--disable-threaded-scrolling", "--disable-threaded-animation", "--run-all-compositor-stages-before-draw"];
/** Real time of the local server and of the page in a local capture, so two runs show the same thing. */
export const FIXED_REAL_NOW = "2026-10-02T12:00:00.000Z";

const GUEST_TEST_USER = "guest-test";
const PASSWORD_ENV = "GUEST_TEST_PASSWORD";

export interface Frame {
  readonly id: ConsoleCaptureId;
  readonly viewport: Viewport;
  readonly png: Buffer;
}

/** Context of one viewport, with every request outside the target aborted and recorded. */
async function guardedContext(browser: Browser, viewport: Viewport, allowed: (url: URL) => boolean, escaped: string[]): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport], deviceScaleFactor: SCALE, locale: "es-AR", timezoneId: "America/Argentina/Buenos_Aires", colorScheme: "light", reducedMotion: "reduce" });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (allowed(url)) return route.continue();
    escaped.push(url.host);
    return route.abort("blockedbyclient");
  });
  return context;
}

/** The guided tour opens by itself for a guest; every capture but `console-tour` shows the view without it. */
async function setTour(page: Page, open: boolean): Promise<void> {
  const toggle = page.getByRole("button", { name: copy.tour.open, exact: true }).first();
  if ((await toggle.count()) === 0) return;
  if (((await toggle.getAttribute("aria-pressed")) === "true") !== open) await toggle.click();
}

async function shoot(page: Page, base: string, id: ConsoleCaptureId, entry: Capture, terms: readonly ForbiddenTerm[], escaped: readonly string[]): Promise<Buffer> {
  await page.goto(`${base}${entry.view}`);
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  if (entry.select) {
    // The select that offers the value (the mailbox filter), whatever the layout puts around it.
    const select = page.locator("select").filter({ has: page.locator(`option[value="${entry.select.value}"]`) }).first();
    await select.selectOption(entry.select.value, { timeout: 30_000 });
  }
  await setTour(page, entry.tour === "open");
  if (entry.scrollTo) await page.locator(entry.scrollTo).evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.evaluate("document.fonts.ready.then(() => undefined)");
  if (escaped.length > 0) throw new Error(`${id}: the console tried to reach ${[...new Set(escaped)].join(", ")}`);
  assertCleanFrame(id, await page.locator("body").innerText(), terms);
  return page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
}

async function consoleVite(): Promise<ViteDevServer> {
  // The build under capture takes the planted session without asking Cognito for anything.
  Object.assign(process.env, { VITE_COGNITO_USER_POOL_ID: TEST_POOL.userPoolId, VITE_COGNITO_CLIENT_ID: TEST_POOL.clientId });
  return createViteServer({ root: WEB_DIR, configFile: join(WEB_DIR, "vite.config.ts"), logLevel: "error", appType: "spa", server: { middlewareMode: true, hmr: false, ws: false } });
}

/** Local captures: one local server per moment, loaded with that moment of the guest's world. */
export async function captureLocal(ids: readonly ConsoleCaptureId[], viewports: readonly Viewport[], terms: readonly ForbiddenTerm[]): Promise<Frame[]> {
  const captures = readCaptures();
  const vite = await consoleVite();
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome", args: DETERMINISTIC_CHROME_ARGS });
  const frames: Frame[] = [];
  try {
    for (const moment of MOMENT_IDS) {
      const here = ids.filter((id) => captures[id].moment === moment);
      if (here.length === 0) continue;
      const fixed = new Date(FIXED_REAL_NOW);
      const server = await startLocalServer((request, response) => vite.middlewares(request, response), { now: () => fixed });
      try {
        await loadMoment(server.app.stores, moment as MomentId);
        const idToken = server.issuer.idToken({ sub: CAPTURE_GUEST.sub, "cognito:username": CAPTURE_GUEST.username, "cognito:groups": ["GUEST"], "custom:firmId": CAPTURE_GUEST.firmId, "custom:role": "GUEST", "custom:isGuest": "true", email: undefined });
        for (const viewport of viewports) {
          const escaped: string[] = [];
          const context = await guardedContext(browser, viewport, localRequestAllowed(server.origin), escaped);
          const page = await context.newPage();
          await page.clock.setFixedTime(fixed);
          await page.addInitScript(plantSessionScript({ idToken, accessToken: "capture-only", expiresAt: fixed.getTime() + 3_600_000 }));
          for (const id of here) frames.push({ id, viewport, png: await shoot(page, server.origin, id, captures[id], terms, escaped) });
          await context.close();
        }
      } finally {
        await server.close();
      }
    }
  } finally {
    await browser.close();
    await vite.close();
  }
  return frames;
}

/** Captures of the stage, after a real run of the guided tour: the real sign-in of `guest-test`. */
async function capturePoc(base: string, ids: readonly ConsoleCaptureId[], viewports: readonly Viewport[], terms: readonly ForbiddenTerm[]): Promise<Frame[]> {
  const password = process.env[PASSWORD_ENV];
  if (!password) throw new Error(`${PASSWORD_ENV} is not set: the guest-test password comes only from the environment`);
  const captures = readCaptures();
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome" });
  const frames: Frame[] = [];
  try {
    for (const viewport of viewports) {
      const escaped: string[] = [];
      const context = await guardedContext(browser, viewport, stageRequestAllowed(base), escaped);
      const page = await context.newPage();
      await page.goto(`${base}/login`);
      await page.locator('input[autocomplete="username"], input[autocomplete="email"]').first().fill(GUEST_TEST_USER);
      await page.locator('input[autocomplete="current-password"]').fill(password);
      await page.locator('form button[type="submit"]').click();
      await page.waitForURL(/\/app\//, { timeout: 90_000 });
      for (const id of ids) frames.push({ id, viewport, png: await shoot(page, base, id, captures[id], terms, escaped) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return frames;
}

function headCommit(): string {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  const options = parseCaptureArgs(process.argv.slice(2));
  const terms = termsFor(true);
  const captures = readCaptures();
  const asked = CONSOLE_CAPTURE_IDS.filter((id) => !options.only || options.only.has(id));
  for (const id of asked) if (captures[id].pending) process.stdout.write(`${id}: pending, not captured (${captures[id].pending})\n`);
  const wanted = asked.filter((id) => !captures[id].pending);
  if (wanted.length === 0) throw new Error("no capture to take: --only matches none, or only pending ones");
  const viewports = Object.keys(VIEWPORTS) as Viewport[];
  const frames = options.target === "poc" ? await capturePoc(options.baseUrl, wanted, viewports, terms) : await captureLocal(wanted, viewports, terms);
  const capturedAt = new Date().toISOString().slice(0, 10);
  const commit = headCommit();
  for (const frame of frames) {
    if (options.out) {
      const dir = resolve(options.out);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${frame.id}-${frame.viewport}.png`), frame.png);
    } else {
      const sources = await encodePicture(frame.id, frame.viewport, frame.png);
      recordEntry({ id: frame.id, viewport: frame.viewport, status: "capture", origin: options.target, sources, capturedAt, commit });
    }
    process.stdout.write(`${frame.id}/${frame.viewport}  ${Math.round(frame.png.byteLength / 1024)} KB  ${options.target}\n`);
  }
}

if (process.argv[1] === import.meta.filename) {
  main().catch((error: unknown) => {
    process.stderr.write(`capture-console: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
