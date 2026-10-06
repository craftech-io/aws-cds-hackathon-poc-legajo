// Renders the connected architecture diagram for the public landing, in both languages, from the same
// source as the README's (docs/assets/architecture/architecture.html), so the two never drift: the page
// is loaded as it is, its text is rewritten in the page for the product's voice (no submission labels,
// no model name, no "mock") and, for Spanish, translated; then the canvas is shot at twice its size and
// written as WebP (1920 px for the page, 3840 px for "open full size") next to the landing's assets.
// A text of the source that has no entry here stops the render, so a new box cannot ship untranslated.
//
//   npx tsx scripts/diagram/render-architecture-public.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { DIAGRAM_TEXTS, type DiagramLang } from "./public-texts";

const SOURCE = resolve("docs/assets/architecture/architecture.html");
const OUT_DIR = resolve("packages/web/public/landing/architecture");
const LANGS: readonly DiagramLang[] = ["es", "en"];
const WIDTHS = [1920, 3840] as const;

/** Spanish runs longer than English: the same boxes, a hair smaller type. */
const SPANISH_FIT = ".box .d { font-size: 12.6px; line-height: 1.34; } .box .t { font-size: 16.5px; } .step .d { font-size: 12.4px; } .legend { font-size: 13.6px; }";

interface PageArgs {
  readonly entries: ReadonlyArray<{ readonly from: string; readonly prefix: boolean; readonly en: string; readonly es: string }>;
  readonly es: boolean;
  readonly fit: string;
}

/** Runs inside the page (a string: the scripts' TypeScript has no DOM types). Returns the texts without an entry. */
const REWRITE_PAGE = `({ entries, es, fit }) => {
  document.querySelectorAll(".cds").forEach((badge) => badge.remove());
  const missing = [];
  const walker = document.createTreeWalker(document.querySelector("#canvas"), NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  for (const node of nodes) {
    const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
    if (text === "" || /^[\\d✓✉💬]$/u.test(text)) continue;
    const entry = entries.find((candidate) => (candidate.prefix ? text.startsWith(candidate.from) : candidate.from === text));
    if (!entry) {
      missing.push(text);
      continue;
    }
    node.textContent = es ? entry.es : entry.en;
  }
  if (es) {
    const style = document.createElement("style");
    style.textContent = fit;
    document.head.append(style);
  }
  return missing;
}`;

async function render(lang: DiagramLang): Promise<Buffer> {
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1380 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(SOURCE).href, { waitUntil: "networkidle" });
    const entries = DIAGRAM_TEXTS.map((entry) => ({ from: entry.from, prefix: entry.prefix ?? false, en: entry.en ?? entry.from, es: entry.es }));
    const args: PageArgs = { entries, es: lang === "es", fit: SPANISH_FIT };
    const unmapped = await page.evaluate<string[]>(`(${REWRITE_PAGE})(${JSON.stringify(args)})`);
    if (unmapped.length > 0) throw new Error(`texts of the source without an entry in public-texts.ts:\n  ${unmapped.join("\n  ")}`);
    return await page.locator("#canvas").screenshot({ type: "png" });
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const lang of LANGS) {
    const png = await render(lang);
    for (const width of WIDTHS) {
      const webp = await sharp(png).resize({ width }).webp({ quality: 88, effort: 6 }).toBuffer();
      const file = `${OUT_DIR}/architecture-${lang}-${width}.webp`;
      writeFileSync(file, webp);
      console.log(`render-architecture-public: ${file} (${Math.round(webp.length / 1024)} KB)`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(`render-architecture-public: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
