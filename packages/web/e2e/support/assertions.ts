// Checks every console spec shares (docs/test-plan.md §3): the view that is open, basic
// accessibility (one page heading, every control named), no raw codes or ids a person would read,
// and no request leaving the machine.
import { type Page, expect } from "@playwright/test";
import { copy } from "../../src/copy/console.ts";
import type { RouteId } from "../../src/routes.ts";

/** Ids of the seed (`firm-delta`, `op-4471`, …) and SCREAMING_CASE enum values (`WITH_OBSERVATION`). */
export const RAW_CODE = /\b(?:firm|brk|imp|sup|ctc|dv|obs|msg)-[a-z0-9]|\bop-\d{4}\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

export async function expectView(page: Page, view: RouteId): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: copy.views[view].title })).toBeVisible();
}

export async function expectNoRawCodes(page: Page): Promise<void> {
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(RAW_CODE);
}

/** One page heading, and every button and link with an accessible name. */
export async function expectAccessibleBasics(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll("button, a[href], input, select, textarea")]
      .filter((element) => {
        const labelled = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "";
        const text = (element.textContent ?? "").trim();
        const byLabel = element.id !== "" && document.querySelector(`label[for="${CSS.escape(element.id)}"]`) !== null;
        const wrapped = element.closest("label") !== null;
        return labelled.trim() === "" && text === "" && !byLabel && !wrapped;
      })
      .map((element) => element.outerHTML.slice(0, 80)),
  );
  expect(unnamed).toEqual([]);
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * Keeps every request on the machine: anything not local is aborted and recorded, except the hosts a
 * spec answers itself with page.route (the Cognito endpoint), which are registered after this and win.
 */
export async function blockExternalRequests(page: Page): Promise<string[]> {
  const blocked: string[] = [];
  await page.route(
    (url) => !LOCAL_HOSTS.has(url.hostname) && url.protocol !== "data:" && url.protocol !== "blob:",
    async (route) => {
      blocked.push(new URL(route.request().url()).hostname);
      await route.abort("blockedbyclient");
    },
  );
  return blocked;
}
