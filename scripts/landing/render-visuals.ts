// Renders of real pages for the landing's gallery, made offline from the real code over the synthetic
// world (status `render` in public/landing/manifest.json):
//
//   npx tsx scripts/landing/render-visuals.ts
//
//   - upload-page.png   /u/<token> of operation 4471 on a phone, with the certificate of origin
//                       already uploaded: the real PublicWeb handler, page script and S3 emulator of
//                       the local UI server (local-server.ts)
//   - upload-done.png   the same page after "Listo": what arrived and what is still missing
//
// The console views come from capture-console.ts. Every request the browser makes stays on
// 127.0.0.1; anything else is aborted and fails the run. The text of each frame is checked before it
// is written (frame-check.ts).
import { type Page, chromium } from "@playwright/test";
import { documentLabel, uploadPageEsAR } from "@legajo/bff/public-web/copy";
import { assertCleanFrame, termsFor } from "./frame-check";
import { newUploadLink, startLocalServer, syntheticPdf } from "./local-server";
import { LANDING_DIR, recordInManifest, writePicture } from "./manifest-file";

/** A phone's width; each frame is as tall as what it shows. */
const VIEWPORTS = { "upload-page": { width: 390, height: 760 }, "upload-done": { width: 390, height: 440 } } as const;
const SCALE = 2;

async function shoot(page: Page, id: "upload-page" | "upload-done", terms: ReturnType<typeof termsFor>, escaped: readonly string[]): Promise<void> {
  if (escaped.length > 0) throw new Error(`${id}: the page tried to leave the machine (${escaped.join(", ")})`);
  const viewport = VIEWPORTS[id];
  await page.setViewportSize(viewport);
  assertCleanFrame(id, await page.locator("body").innerText(), terms);
  const file = writePicture(LANDING_DIR, id, await page.screenshot({ type: "png", animations: "disabled", caret: "hide" }));
  recordInManifest(id, { file, width: viewport.width * SCALE, height: viewport.height * SCALE, status: "render" });
  process.stdout.write(`${file}\n`);
}

async function main(): Promise<void> {
  const terms = termsFor(false);
  const server = await startLocalServer();
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome" });
  const escaped: string[] = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORTS["upload-page"], deviceScaleFactor: SCALE, locale: "es-AR", timezoneId: "America/Argentina/Buenos_Aires", colorScheme: "light", reducedMotion: "reduce" });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(`${server.origin}/`)) return route.continue();
      escaped.push(new URL(url).host);
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    const link = await newUploadLink(server.app);
    await page.goto(`${server.origin}/u/${link.token}`);
    const certificate = page.getByRole("listitem").filter({ hasText: documentLabel("CERTIFICATE_OF_ORIGIN") });
    await page.getByLabel(documentLabel("CERTIFICATE_OF_ORIGIN"), { exact: true }).setInputFiles({ name: "certificate-of-origin.pdf", mimeType: "application/pdf", buffer: syntheticPdf(48_213) });
    await certificate.getByRole("status").filter({ hasText: uploadPageEsAR.script.uploaded }).waitFor();
    await shoot(page, "upload-page", terms, escaped);

    await page.getByRole("button", { name: uploadPageEsAR.doneButton }).click();
    await page.getByRole("heading", { name: uploadPageEsAR.confirmationHeading }).waitFor();
    await shoot(page, "upload-done", terms, escaped);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`render-visuals: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
