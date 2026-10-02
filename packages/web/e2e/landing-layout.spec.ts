// FL-127 · the landing at any width, accessible and light (docs/landing-spec.md §5), in the six projects
// of docs/test-plan.md §3 and at 360, 390, 768, 1024 and 1440 px: never a horizontal scroll, touch
// targets of at least 44 px in the header and the tour's controls, the console never downloaded on
// `/`, and the metadata of §5.4 (title, description, Open Graph with a real capture, hreflang es/en).
import { type TestInfo, expect, test } from "@playwright/test";
import { LANDING_COPY } from "../src/views/landing/copy.ts";
import { blockExternalRequests } from "./support/assertions";

const WIDTHS = [360, 390, 768, 1024, 1440] as const;
/** What the console's chunk would load in development: its routes, its shell and its views (a view's texts may be shared). */
const CONSOLE_MODULES = /\/src\/(console-routes\.tsx|components\/layout\/AppShell\.tsx|views\/[a-z]+\/View\.tsx)/;

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

test.describe("[FL-127] landing en cualquier ancho", () => {
  test("[FL-127] never scrolls sideways at 360, 390, 768, 1024 and 1440 px", async ({ page }, info) => {
    const lang = langOf(info);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${lang === "en" ? "?lang=en" : ""}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(sizes.scroll, `${width} px`).toBeLessThanOrEqual(sizes.client);
    }
  });

  test("[FL-127] keeps the header's controls and the tour's buttons at least 44 px tall", async ({ page }, info) => {
    const copy = LANDING_COPY[langOf(info)];
    await page.goto(`/${langOf(info) === "en" ? "?lang=en" : ""}`);
    // The skip link stays visually hidden until it takes the focus.
    const controls = page.getByRole("banner").locator("a:visible:not(.sr-only), button:visible");
    const count = await controls.count();
    expect(count).toBeGreaterThan(1);
    for (let index = 0; index < count; index += 1) {
      const box = await controls.nth(index).boundingBox();
      expect(box?.height ?? 0, await controls.nth(index).innerText()).toBeGreaterThanOrEqual(44);
    }
    if (info.project.name.startsWith("mobile")) {
      for (const name of [copy.tour.previous, copy.tour.next]) {
        const box = await page.getByRole("button", { name }).boundingBox();
        expect((box?.height ?? 0) >= 44 && (box?.width ?? 0) >= 44, name).toBe(true);
      }
    }
  });

  test("[FL-127] never downloads the console on / and declares its metadata without noindex", async ({ page }, info) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(new URL(request.url()).pathname));
    await page.goto(`/${langOf(info) === "en" ? "?lang=en" : ""}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForLoadState("networkidle");
    expect(requested.filter((path) => CONSOLE_MODULES.test(path))).toEqual([]);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /legajo/i);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /\/landing\/og-card\/desktop\.png$/);
    await expect(page.locator('link[rel="alternate"][hreflang="es-AR"]')).toHaveCount(1);
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveCount(1);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    expect((await page.request.get("/landing/og-card/desktop.png")).status()).toBe(200);
  });
});
