// The upload page is not built by Vite, so it carries its own copy of the console's palette
// (html.ts `UPLOAD_PAGE_STYLE`): every colour it declares must be the console's `--color-*` token of
// the same name in packages/web/src/index.css, so the two never drift apart.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UPLOAD_PAGE_STYLE } from "./html";

const THEME = readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");

function declared(css: string, prefix: string): Map<string, string> {
  return new Map([...css.matchAll(new RegExp(`--${prefix}([a-z-]+):\\s*(#[0-9a-fA-F]{6})`, "g"))].map((match) => [match[1] ?? "", (match[2] ?? "").toLowerCase()]));
}

describe("the upload page's palette", () => {
  it("is the console's theme, token by token", () => {
    const page = declared(UPLOAD_PAGE_STYLE, "");
    const theme = declared(THEME, "color-");
    expect(page.size).toBeGreaterThan(5);
    for (const [name, value] of page) expect({ name, value }).toEqual({ name, value: theme.get(name) });
  });
});
