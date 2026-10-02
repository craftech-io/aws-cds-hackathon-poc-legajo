// Pictures of real pages served locally (ADR-0016 §4, docs/landing-spec.md §7.3), made from the real
// code over the synthetic world, every request kept on 127.0.0.1 and every frame's text checked first:
//
//   FORBIDDEN_TERMS=… npx tsx scripts/landing/render-visuals.ts
//
//   - upload-page, upload-done   /u/<token> of operation 4471 on a phone (the real PublicWeb handler,
//                                page script and S3 emulator), before and after "Listo": captures, origin local
//   - og-card                    the landing's own hero at 1200x630, the Open Graph image: capture, origin local
//   - hero-conversation, tour-*  the still frame of each render (its final state, reduced motion), cut
//                                from the landing in Spanish: what "Ampliar" shows while the capture that
//                                replaces it does not exist (manifest status `render`, scripts/landing/renders.json)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page, chromium } from "@playwright/test";
import { documentLabel, uploadPageEsAR } from "@legajo/bff/public-web/copy";
import { createServer as createViteServer } from "vite";
import type { MediaId, Viewport } from "../../packages/web/src/views/landing/manifest";
import { HERO_VISUAL, TOUR_STEPS } from "../../packages/web/src/views/landing/tour-steps";
import type { ForbiddenTerm } from "../lint/forbidden-terms";
import { DETERMINISTIC_CHROME_ARGS } from "./capture-console";
import { RendersFile } from "./check-rules";
import { encodePicture } from "./encode";
import { assertCleanFrame, termsFor } from "./frame-check";
import { type LocalServer, newUploadLink, startLocalServer, syntheticPdf } from "./local-server";
import { RENDERS_PATH, WEB_DIR, recordEntry } from "./manifest-file";

const PHONE = { width: 390, height: 760 } as const;
const UPLOAD_DONE_HEIGHT = 440;
const CARD = { width: 1200, height: 630 } as const;
/** The landing's stacked tour (768–1023 px) draws every step's render at once. */
const STACKED = { width: 960, height: 1200 } as const;

function guard(server: LocalServer, escaped: string[]) {
  return (route: { request(): { url(): string }; continue(): Promise<void>; abort(reason: string): Promise<void> }) => {
    const url = route.request().url();
    if (url.startsWith(`${server.origin}/`)) return route.continue();
    escaped.push(new URL(url).host);
    return route.abort("blockedbyclient");
  };
}

async function capture(id: MediaId, viewport: Viewport, png: Buffer, commit: string): Promise<void> {
  const sources = await encodePicture(id, viewport, png);
  recordEntry({ id, viewport, status: "capture", origin: "local", sources, capturedAt: new Date().toISOString().slice(0, 10), commit });
  process.stdout.write(`${id}/${viewport}  capture (local)\n`);
}

async function uploadPages(browser: Browser, server: LocalServer, terms: readonly ForbiddenTerm[], commit: string): Promise<void> {
  const escaped: string[] = [];
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, locale: "es-AR", timezoneId: "America/Argentina/Buenos_Aires", colorScheme: "light", reducedMotion: "reduce" });
  await context.route("**/*", guard(server, escaped));
  const page = await context.newPage();
  const link = await newUploadLink(server.app);
  await page.goto(`${server.origin}/u/${link.token}`);
  const certificate = page.getByRole("listitem").filter({ hasText: documentLabel("CERTIFICATE_OF_ORIGIN") });
  await page.getByLabel(documentLabel("CERTIFICATE_OF_ORIGIN"), { exact: true }).setInputFiles({ name: "certificate-of-origin.pdf", mimeType: "application/pdf", buffer: syntheticPdf(48_213) });
  await certificate.getByRole("status").filter({ hasText: uploadPageEsAR.script.uploaded }).waitFor();
  const shots: Array<readonly [MediaId, Buffer]> = [];
  assertCleanFrame("upload-page", await page.locator("body").innerText(), terms);
  shots.push(["upload-page", await page.screenshot({ type: "png", animations: "disabled", caret: "hide" })]);
  await page.getByRole("button", { name: uploadPageEsAR.doneButton }).click();
  await page.getByRole("heading", { name: uploadPageEsAR.confirmationHeading }).waitFor();
  assertCleanFrame("upload-done", await page.locator("body").innerText(), terms);
  // A clip of the same viewport, never a resize: right after setViewportSize Chrome can return the
  // old size's compositor tiles, and the frame comes out with the page tiled (header repeated).
  shots.push(["upload-done", await page.screenshot({ type: "png", animations: "disabled", caret: "hide", clip: { x: 0, y: 0, width: PHONE.width, height: UPLOAD_DONE_HEIGHT } })]);
  if (escaped.length > 0) throw new Error(`the upload page tried to leave the machine (${escaped.join(", ")})`);
  await context.close();
  for (const [id, png] of shots) await capture(id, "mobile", png, commit);
}

async function landingPage(browser: Browser, server: LocalServer, size: { readonly width: number; readonly height: number }, scale: number, escaped: string[]): Promise<Page> {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: scale, locale: "es-AR", timezoneId: "America/Argentina/Buenos_Aires", colorScheme: "light", reducedMotion: "reduce" });
  await context.route("**/*", guard(server, escaped));
  const page = await context.newPage();
  await page.goto(`${server.origin}/?lang=es`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.evaluate("document.fonts.ready.then(() => undefined)");
  return page;
}

async function card(browser: Browser, server: LocalServer, terms: readonly ForbiddenTerm[], commit: string): Promise<void> {
  const escaped: string[] = [];
  const page = await landingPage(browser, server, CARD, 1, escaped);
  assertCleanFrame("og-card", await page.locator("#top").innerText(), terms);
  const png = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
  if (escaped.length > 0) throw new Error(`the landing tried to leave the machine (${escaped.join(", ")})`);
  await page.context().close();
  await capture("og-card", "desktop", png, commit);
}

async function renderFrames(browser: Browser, server: LocalServer, terms: readonly ForbiddenTerm[]): Promise<void> {
  const renders = RendersFile.parse(JSON.parse(readFileSync(RENDERS_PATH, "utf8")));
  const escaped: string[] = [];
  const page = await landingPage(browser, server, STACKED, 2, escaped);
  const targets: Array<readonly [MediaId, string]> = [[HERO_VISUAL.render, "[data-hero-visual] figure"], ...TOUR_STEPS.map((step) => [step.render, `[data-step-visual="${step.id}"]`] as const)];
  for (const [id, selector] of targets) {
    const record = renders[id as keyof typeof renders];
    if (!record) throw new Error(`${id} is not in scripts/landing/renders.json`);
    const element = page.locator(selector).first();
    await element.scrollIntoViewIfNeeded();
    assertCleanFrame(id, await element.innerText(), terms);
    const png = await element.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    const sources = await encodePicture(id, "desktop", png);
    recordEntry({ id, viewport: "desktop", status: "render", sources, component: record.component, textSources: record.textSources, replacedBy: record.replacedBy, replaceIn: record.replaceIn });
    process.stdout.write(`${id}/desktop  render frame\n`);
  }
  if (escaped.length > 0) throw new Error(`the landing tried to leave the machine (${escaped.join(", ")})`);
  await page.context().close();
}

async function main(): Promise<void> {
  const terms = termsFor(true);
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const vite = await createViteServer({ root: WEB_DIR, configFile: join(WEB_DIR, "vite.config.ts"), logLevel: "error", appType: "spa", server: { middlewareMode: true, hmr: false, ws: false } });
  const server = await startLocalServer((request, response) => vite.middlewares(request, response));
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome", args: DETERMINISTIC_CHROME_ARGS });
  try {
    await uploadPages(browser, server, terms, commit);
    await card(browser, server, terms, commit);
    await renderFrames(browser, server, terms);
  } finally {
    await browser.close();
    await server.close();
    await vite.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`render-visuals: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
