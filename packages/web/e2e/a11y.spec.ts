// FL-127 · accessibility of the public pages (WCAG 2.2 AA, docs/landing-spec.md §5.2), in the six
// projects of docs/test-plan.md §3: axe-core over `/`, `/signup`, `/login` and `/forgot` in the
// project's language, over `/signup` showing its error summary, over the gallery's dialog and over a
// guest's first console screen after /welcome (the tour panel open), without a `serious` or `critical`
// violation; target size (WCAG 2.5.8) is part of the `wcag22aa` rules. On top of axe, the first
// controls a guest touches and the brand link of the access screens are at least 44 px tall (the
// touch-target rule of the public surfaces). Contrast is measured on the final state of every reveal
// (the page with reduced motion), never on a frame in the middle of an animation.
import AxeBuilder from "@axe-core/playwright";
import { type Locator, type Page, type TestInfo, expect, test } from "@playwright/test";
import { createVerifiedGuest, routeCognitoToServer, testMailbox, testViewerIp, useViewerIp } from "../../../tests/ui-server/auth/browser-helpers.ts";
import { copy as consoleCopy } from "../src/copy/console.ts";
import { AUTH_COPY } from "../src/views/auth/copy.ts";
import { blockExternalRequests } from "./support/assertions";
import { UI_SERVER_URL } from "./support/env";

// Fixture password of the in-memory pool: it never leaves this machine.
const PASSWORD = "Clave-de-Prueba-2026!";

const PAGES = ["/", "/signup", "/login", "/forgot"] as const;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

function langOf(info: TestInfo): "es" | "en" {
  return /(^|-)en(-|$)/.test(info.project.name) ? "en" : "es";
}

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).slice(0, 3).join(" | ")}`);
}

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

test.describe("[FL-127] accesibilidad de las superficies públicas", () => {
  for (const path of PAGES) {
    test(`[FL-127] ${path} has no serious or critical violation`, async ({ page }, info) => {
      await page.goto(`${path}${langOf(info) === "en" ? "?lang=en" : ""}`);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(await seriousViolations(page)).toEqual([]);
    });
  }

  test("[FL-127] the gallery's dialog has no serious or critical violation", async ({ page }, info) => {
    await page.goto(`/${langOf(info) === "en" ? "?lang=en" : ""}#gallery`);
    await page.locator("#gallery figure button").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test("[FL-127] /signup with its error summary has no serious or critical violation", async ({ page }, info) => {
    const t = AUTH_COPY[langOf(info)];
    await page.goto(`/signup${langOf(info) === "en" ? "?lang=en" : ""}`);
    await page.getByRole("button", { name: t.signup.submit }).click();
    const summary = page.getByRole("alert").filter({ hasText: t.signup.errors.summary(3) });
    await expect(summary).toBeVisible();
    for (const link of await summary.getByRole("link").all()) expect((await link.boundingBox())?.height ?? 0, await link.innerText()).toBeGreaterThanOrEqual(44);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test("[FL-127] keeps the brand link of the access screens at least 44 px tall", async ({ page }, info) => {
    for (const path of ["/signup", "/login", "/forgot"]) {
      await page.goto(`${path}${langOf(info) === "en" ? "?lang=en" : ""}`);
      const brand = page.getByRole("link", { name: /Powered by/ }).first();
      await expect(brand).toBeVisible();
      expect((await brand.boundingBox())?.height ?? 0, path).toBeGreaterThanOrEqual(44);
    }
  });

  test("[FL-127] a guest's first console screen has no violation and 44 px controls", async ({ page, request }, info) => {
    const t = AUTH_COPY[langOf(info)];
    await routeCognitoToServer(page, UI_SERVER_URL);
    await useViewerIp(page, testViewerIp(info));
    const email = testMailbox(info, "a11y-console");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await page.goto(`/login${langOf(info) === "en" ? "?lang=en" : ""}`);
    await page.getByLabel(t.login.login).fill(email);
    await page.getByLabel(t.login.password, { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: t.login.submit }).click();
    await expect(page).toHaveURL(/\/app\//, { timeout: 20_000 });
    const tour = page.getByRole("complementary", { name: consoleCopy.tour.title });
    await expect(tour).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await seriousViolations(page)).toEqual([]);
    const small = await shortControls([tour, page.getByRole("navigation", { name: consoleCopy.app.navigation }), page.getByRole("region", { name: consoleCopy.clock.region }), page.getByRole("banner")]);
    expect(small).toEqual([]);
  });
});

/** Visible links and buttons under `roots` shorter than 44 px, with their text and height. */
async function shortControls(roots: readonly Locator[]): Promise<string[]> {
  const short: string[] = [];
  for (const root of roots) {
    for (const control of await root.locator("a:visible, button:visible").all()) {
      const box = await control.boundingBox();
      if (box && box.height < 44) short.push(`${(await control.innerText()).trim() || (await control.getAttribute("aria-label")) || "?"}: ${Math.round(box.height)} px`);
    }
  }
  return short;
}
