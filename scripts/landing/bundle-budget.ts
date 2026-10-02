// `npm run landing:budget` (docs/landing-spec.md §5.3, FL-127), after `npm run build -w packages/web`:
// what a visitor of `/` downloads before the page can render must stay within budget. The JavaScript
// of the landing and the sign-in screens is the entry script of dist/index.html plus every chunk it
// imports statically (followed through `import … from "./x.js"`, never through a dynamic `import()`,
// which is how the console and the gallery's viewer load); none of those chunks may be the console's
// (`console-routes-*` or a view's `View-*`). Budgets, gzip level 9: the app's own JavaScript (landing
// and access) ≤ 90 KB; the third-party runtime, which packages/web/vite.config.ts puts in `vendor-*`
// chunks (React, zod, tRPC), ≤ 100 KB on its own cap; CSS ≤ 35 KB in total; the title font ≤ 45 KB on
// disk. Exit 0 within budget, 1 over it, 2 without a build.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const BUDGET_KB = { js: 90, vendor: 100, css: 35, font: 45 } as const;

const KB = 1024;
const CONSOLE_CHUNK = /^(console-routes|View)-[\w-]+\.js$/;
const VENDOR_CHUNK = /^vendor-[a-z]+-[\w-]+\.js$/;

export interface SizedFile {
  readonly file: string;
  readonly bytes: number;
  readonly gzip: number;
}

export interface BudgetReport {
  /** The app's own chunks of `/` (landing and access). */
  readonly js: readonly SizedFile[];
  /** The `vendor-*` chunks of `/`: third-party runtime, on its own cap. */
  readonly vendor: readonly SizedFile[];
  readonly css: readonly SizedFile[];
  readonly fonts: readonly SizedFile[];
  readonly totals: { readonly jsGzip: number; readonly vendorGzip: number; readonly cssGzip: number; readonly fontBytes: number };
  /** Console chunks that `/` would download before rendering (must be none). */
  readonly consoleInInitial: readonly string[];
  readonly problems: readonly string[];
}

function sized(dir: string, file: string): SizedFile {
  const bytes = readFileSync(join(dir, file));
  return { file, bytes: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength };
}

/** `assets/x.js` chunks named by the HTML: the module entry and its preloads. */
export function htmlScripts(html: string): string[] {
  const sources = [...html.matchAll(/<script[^>]*type="module"[^>]*src="\/([^"]+\.js)"/g), ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/([^"]+\.js)"/g)];
  return [...new Set(sources.map((match) => match[1] ?? ""))].filter(Boolean);
}

/** Chunks a chunk imports statically (`import "./a.js"`, `import{x}from"./b.js"`), never `import("./c.js")`. */
export function staticImports(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(/(?<![\w$.])import\s*(?:[\w$*{}\s,]+?\s*from\s*)?["'](\.\/[^"']+\.js)["']/g)) found.add(match[1]?.slice(2) ?? "");
  for (const match of code.matchAll(/(?<![\w$.])export\s*(?:\*|\{[^}]*\})\s*from\s*["'](\.\/[^"']+\.js)["']/g)) found.add(match[1]?.slice(2) ?? "");
  return [...found].filter(Boolean);
}

/** The entry's static closure, as paths relative to dist/. */
export function initialScripts(distDir: string): string[] {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  const queue = htmlScripts(html);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift() ?? "";
    if (seen.has(next) || !existsSync(join(distDir, next))) continue;
    seen.add(next);
    const dir = next.includes("/") ? next.slice(0, next.lastIndexOf("/") + 1) : "";
    for (const imported of staticImports(readFileSync(join(distDir, next), "utf8"))) queue.push(`${dir}${imported}`);
  }
  return [...seen];
}

function filesWith(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(extension) && statSync(join(dir, file)).isFile());
}

export function measureBudget(distDir: string): BudgetReport {
  if (!existsSync(join(distDir, "index.html"))) throw new Error(`${distDir}/index.html does not exist: build the web first (npm run build -w packages/web)`);
  const initial = initialScripts(distDir).map((file) => sized(distDir, file));
  const isVendor = (file: SizedFile) => VENDOR_CHUNK.test(file.file.split("/").pop() ?? "");
  const js = initial.filter((file) => !isVendor(file));
  const vendor = initial.filter(isVendor);
  const css = filesWith(join(distDir, "assets"), ".css").map((file) => sized(distDir, `assets/${file}`));
  const fonts = filesWith(join(distDir, "fonts"), ".woff2").map((file) => sized(distDir, `fonts/${file}`));
  const totals = {
    jsGzip: js.reduce((sum, file) => sum + file.gzip, 0),
    vendorGzip: vendor.reduce((sum, file) => sum + file.gzip, 0),
    cssGzip: css.reduce((sum, file) => sum + file.gzip, 0),
    fontBytes: fonts.reduce((sum, file) => sum + file.bytes, 0),
  };
  const consoleInInitial = js.map((file) => file.file.split("/").pop() ?? "").filter((name) => CONSOLE_CHUNK.test(name));
  const problems = [
    ...(totals.jsGzip > BUDGET_KB.js * KB ? [`JavaScript of / is ${(totals.jsGzip / KB).toFixed(1)} KB gzip, over ${BUDGET_KB.js} KB`] : []),
    ...(totals.vendorGzip > BUDGET_KB.vendor * KB ? [`Third-party JavaScript of / is ${(totals.vendorGzip / KB).toFixed(1)} KB gzip, over ${BUDGET_KB.vendor} KB`] : []),
    ...(totals.cssGzip > BUDGET_KB.css * KB ? [`CSS is ${(totals.cssGzip / KB).toFixed(1)} KB gzip, over ${BUDGET_KB.css} KB`] : []),
    ...(totals.fontBytes > BUDGET_KB.font * KB ? [`the title font is ${(totals.fontBytes / KB).toFixed(1)} KB, over ${BUDGET_KB.font} KB`] : []),
    ...(fonts.length === 0 ? ["no title font under dist/fonts (public/fonts/*.woff2)"] : []),
    ...consoleInInitial.map((name) => `${name} is a console chunk and / downloads it before rendering`),
  ];
  return { js, vendor, css, fonts, totals, consoleInInitial, problems };
}

export function formatReport(report: BudgetReport): string {
  const kb = (bytes: number) => `${(bytes / KB).toFixed(1)} KB`;
  const listed = (files: readonly SizedFile[]) => [...files].sort((a, b) => b.gzip - a.gzip).map((file) => `  ${file.file}  ${kb(file.gzip)} gzip (${kb(file.bytes)})`);
  const lines = [
    `JavaScript of / (entry and static imports, landing and access): ${kb(report.totals.jsGzip)} gzip of ${BUDGET_KB.js} KB`,
    ...listed(report.js),
    `Third-party runtime of / (vendor-* chunks): ${kb(report.totals.vendorGzip)} gzip of ${BUDGET_KB.vendor} KB`,
    ...listed(report.vendor),
    `Total JavaScript before / renders: ${kb(report.totals.jsGzip + report.totals.vendorGzip)} gzip`,
    `CSS: ${kb(report.totals.cssGzip)} gzip of ${BUDGET_KB.css} KB`,
    `Title font: ${kb(report.totals.fontBytes)} of ${BUDGET_KB.font} KB`,
  ];
  return lines.join("\n");
}

function main(): void {
  const distDir = join(import.meta.dirname, "../../packages/web/dist");
  let report: BudgetReport;
  try {
    report = measureBudget(distDir);
  } catch (error) {
    process.stderr.write(`landing:budget: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${formatReport(report)}\n`);
  if (report.problems.length > 0) {
    process.stderr.write(`landing:budget: over budget\n${report.problems.map((problem) => `  ${problem}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("landing:budget: within budget\n");
}

if (process.argv[1] === import.meta.filename) main();
