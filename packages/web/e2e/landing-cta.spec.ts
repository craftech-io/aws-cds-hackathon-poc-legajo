// FL-130 · the calls to action and where the visit came from (docs/landing-spec.md §9, ADR-0015 §2), in
// the six projects of docs/test-plan.md §3: "Probar la demo" reaches /signup with a full page load and
// the visit's valid campaign parameters, which also stay in sessionStorage (no cookie, no analytics);
// "Ingresar" opens the login; every "Hablemos" opens Craftech's contact page in a new tab, with the
// placement as `utm_content`.
import { type TestInfo, expect, test } from "@playwright/test";
import { LANDING_COPY } from "../src/views/landing/copy.ts";
import { ATTRIBUTION_KEY } from "../src/views/landing/utm.ts";
import { CRAFTECH_CONTACT_URL, contactHref } from "../src/views/landing/links.ts";
import { blockExternalRequests } from "./support/assertions";

function langOf(info: TestInfo): "es" | "en" {
  return /(^|-)en(-|$)/.test(info.project.name) ? "en" : "es";
}

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

test.describe("[FL-130] llamados a la acción y origen de la visita", () => {
  test("[FL-130] carries the valid utm_* parameters to /signup and keeps them in sessionStorage, without cookies", async ({ page, context }, info) => {
    const lang = langOf(info);
    const copy = LANDING_COPY[lang];
    await page.goto(`/?utm_source=news&utm_campaign=launch-2026&utm_medium=%3Cscript%3E${lang === "en" ? "&lang=en" : ""}`);
    const hero = page.locator("#top").getByRole("link", { name: copy.hero.primary });
    await expect(hero).toHaveAttribute("href", "/signup?utm_source=news&utm_campaign=launch-2026");
    const stored = await page.evaluate((key) => window.sessionStorage.getItem(key), ATTRIBUTION_KEY);
    expect(JSON.parse(stored ?? "{}")).toEqual({ utm: { source: "news", campaign: "launch-2026" } });
    await hero.click();
    await page.waitForURL(/\/signup\?utm_source=news&utm_campaign=launch-2026$/);
    expect(JSON.parse((await page.evaluate((key) => window.sessionStorage.getItem(key), ATTRIBUTION_KEY)) ?? "{}")).toEqual({ utm: { source: "news", campaign: "launch-2026" } });
    expect((await context.cookies()).map((cookie) => cookie.name)).toEqual([]);
  });

  test("[FL-130] 'Ingresar' opens the login", async ({ page }, info) => {
    const copy = LANDING_COPY[langOf(info)];
    await page.goto(`/${langOf(info) === "en" ? "?lang=en" : ""}`);
    await page.locator("#top").getByRole("link", { name: copy.cta.signIn }).click();
    await expect(page).toHaveURL(/\/login(\?.*)?$/);
  });

  test("[FL-130] sends every 'Hablemos' to Craftech's contact page in a new tab, by placement", async ({ page }, info) => {
    await page.goto(`/${langOf(info) === "en" ? "?lang=en" : ""}`);
    for (const placement of ["platform", "faq", "closing", "footer"] as const) {
      const link = page.locator(`a[href="${contactHref(placement)}"]`);
      await expect(link, placement).toHaveCount(1);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    const contacts = await page.locator(`a[href^="${CRAFTECH_CONTACT_URL}"]`).evaluateAll((links) => links.map((link) => new URL((link as HTMLAnchorElement).href).searchParams.get("utm_source")));
    expect(new Set(contacts)).toEqual(new Set(["legajo-listo"]));
    await expect(page.locator('a[href="mailto:sales@craftech.io"]').first()).toBeAttached();
  });
});
