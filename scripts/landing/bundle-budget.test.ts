// `npm run landing:budget` (FL-127, docs/landing-spec.md §5.3) over a small build on disk: the
// JavaScript of `/` is the entry and what it imports statically, never what it imports dynamically;
// a console chunk in that set fails; the budgets are gzip sizes; a missing build is refused.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUDGET_KB, htmlScripts, initialScripts, measureBudget, staticImports } from "./bundle-budget";

function dist(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "legajo-budget-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const HTML = '<script type="module" crossorigin src="/assets/index-a1.js"></script><link rel="modulepreload" crossorigin href="/assets/runtime-b2.js"><link rel="stylesheet" href="/assets/index-c3.css">';

/** Bytes gzip cannot shrink, so a test controls the gzip size. */
function noise(bytes: number): Buffer {
  return randomBytes(bytes);
}

describe("landing:budget [FL-127]", () => {
  it("reads the entry and its preloads from the HTML and follows static imports only", () => {
    expect(htmlScripts(HTML)).toEqual(["assets/index-a1.js", "assets/runtime-b2.js"]);
    expect(staticImports('import{a as b}from"./format-x.js";import"./side-y.js";const c=()=>import("./View-z.js");export{d}from"./re-w.js"')).toEqual(["format-x.js", "side-y.js", "re-w.js"]);
    const dir = dist({
      "index.html": HTML,
      "assets/index-a1.js": 'import{x}from"./format-x.js";const v=()=>import("./console-routes-q.js");',
      "assets/runtime-b2.js": "",
      "assets/format-x.js": "export const x=1;",
      "assets/console-routes-q.js": 'import"./View-r.js";',
      "assets/View-r.js": "",
    });
    expect(initialScripts(dir).sort()).toEqual(["assets/format-x.js", "assets/index-a1.js", "assets/runtime-b2.js"]);
  });

  it("passes a small build and names a console chunk that / would download before rendering", () => {
    const base = { "index.html": HTML, "assets/runtime-b2.js": "", "assets/index-c3.css": "body{}", "fonts/title.woff2": noise(1024) };
    expect(measureBudget(dist({ ...base, "assets/index-a1.js": "const a=1;" })).problems).toEqual([]);
    const leaking = measureBudget(dist({ ...base, "assets/index-a1.js": 'import"./View-r.js";', "assets/View-r.js": "" }));
    expect(leaking.consoleInInitial).toEqual(["View-r.js"]);
    expect(leaking.problems).toContain("View-r.js is a console chunk and / downloads it before rendering");
  });

  it("measures gzip against the budgets of JavaScript, CSS and the font", () => {
    const over = measureBudget(
      dist({
        "index.html": HTML,
        "assets/index-a1.js": noise((BUDGET_KB.js + 1) * 1024),
        "assets/runtime-b2.js": "",
        "assets/index-c3.css": noise((BUDGET_KB.css + 1) * 1024),
        "fonts/title.woff2": noise((BUDGET_KB.font + 1) * 1024),
      }),
    );
    expect(over.problems.map((problem) => problem.split(" ")[0])).toEqual(["JavaScript", "CSS", "the"]);
    expect(over.totals.jsGzip).toBeGreaterThan(BUDGET_KB.js * 1024);
  });

  it("measures the vendor-* chunks of / on their own cap, apart from the landing and access code", () => {
    const html = `${HTML}<link rel="modulepreload" crossorigin href="/assets/vendor-react-v1.js">`;
    const base = { "index.html": html, "assets/runtime-b2.js": "", "assets/index-c3.css": "body{}", "fonts/title.woff2": noise(1024) };
    const within = measureBudget(dist({ ...base, "assets/index-a1.js": noise((BUDGET_KB.js - 2) * 1024), "assets/vendor-react-v1.js": noise((BUDGET_KB.vendor - 2) * 1024) }));
    expect(within.problems).toEqual([]);
    expect(within.vendor.map((file) => file.file)).toEqual(["assets/vendor-react-v1.js"]);
    expect(within.js.map((file) => file.file)).not.toContain("assets/vendor-react-v1.js");
    const over = measureBudget(dist({ ...base, "assets/index-a1.js": "", "assets/vendor-react-v1.js": noise((BUDGET_KB.vendor + 1) * 1024) }));
    expect(over.problems).toEqual([expect.stringMatching(/^Third-party JavaScript of \/ is .* over 100 KB$/)]);
  });

  it("refuses to measure without a build, and asks for the title font", () => {
    expect(() => measureBudget(join(tmpdir(), "legajo-no-dist"))).toThrow(/build the web first/);
    expect(measureBudget(dist({ "index.html": HTML, "assets/index-a1.js": "", "assets/runtime-b2.js": "" })).problems).toContain("no title font under dist/fonts (public/fonts/*.woff2)");
  });
});
