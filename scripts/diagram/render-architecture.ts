// Renders the AWS architecture diagram of the README and the submission gallery
// (docs/assets/architecture/architecture.html → docs/assets/architecture.png) with Playwright's Chromium,
// at twice the page size so it stays sharp when zoomed. Run it after changing the HTML:
//
//   npx tsx scripts/diagram/render-architecture.ts
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const SOURCE = resolve("docs/assets/architecture/architecture.html");
const OUTPUT = resolve("docs/assets/architecture.png");

async function main(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1820, height: 1180 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(SOURCE).href, { waitUntil: "networkidle" });
    await page.locator("#canvas").screenshot({ path: OUTPUT });
    console.log(`render-architecture: wrote ${OUTPUT}`);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(`render-architecture: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
