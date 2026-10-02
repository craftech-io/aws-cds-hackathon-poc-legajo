// FL-127 · accessibility of the public pages (WCAG 2.2 AA, docs/landing-spec.md §5.2), in the six
// projects of docs/test-plan.md §3: axe-core over `/`, `/signup`, `/login` and `/forgot` in the
// project's language, and over the gallery's dialog, without a `serious` or `critical` violation.
// Contrast is measured on the final state of every reveal (the page with reduced motion), never on a
// frame in the middle of an animation.
import AxeBuilder from "@axe-core/playwright";
import { type Page, type TestInfo, expect, test } from "@playwright/test";
import { blockExternalRequests } from "./support/assertions";

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
});
