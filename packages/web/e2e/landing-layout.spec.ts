// FL-127 · the landing at any width, accessible and light (docs/landing-spec.md §5), in the six projects
// of docs/test-plan.md §3 and at 360, 390, 768, 1024 and 1440 px: never a horizontal scroll, touch
// targets of at least 44 px in the header, the tour's controls and the footer, the console never
// downloaded on `/`, and the metadata of §5.4 (title, description, Open Graph with a real capture,
// hreflang es/en). Every step of the tour is drawn whole: nothing of a step's visual falls outside the
// carousel's slot (390 × 844, at most 56 % of the screen's height) or the desktop's sticky stage, and
// the four goal tiles of "Impacto" keep one height and one baseline.
import { type Locator, type Page, type TestInfo, expect, test } from "@playwright/test";
import { HERO_ANCHOR } from "../src/views/landing/conversations.ts";
import { TOUR_STEPS, stepAnchor } from "../src/views/landing/tour-steps.ts";
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

  test("[FL-127] keeps the footer's legal links at least 44 × 44 px", async ({ page }, info) => {
    const copy = LANDING_COPY[langOf(info)];
    await page.goto(`/${langOf(info) === "en" ? "?lang=en" : ""}`);
    for (const name of [copy.footer.privacy, copy.footer.terms]) {
      const box = await page.getByRole("contentinfo").getByRole("link", { name, exact: true }).boundingBox();
      expect((box?.height ?? 0) >= 44 && (box?.width ?? 0) >= 44, `${name}: ${box?.width}×${box?.height}`).toBe(true);
    }
  });

  test("[FL-127] lines up the four goal tiles of the impact section", async ({ page }, info) => {
    test.skip(info.project.name.startsWith("mobile"), "the tiles share a row from 1024 px");
    await page.goto(`/${langOf(info) === "en" ? "?lang=en" : ""}#impact`);
    const tiles = page.locator("[data-goal-tile]");
    await expect(tiles).toHaveCount(4);
    const boxes = await tiles.evaluateAll((items) => items.map((item) => item.getBoundingClientRect()).map((box) => ({ top: box.top, height: box.height })));
    const values = await page.locator("[data-goal-value]").evaluateAll((items) => items.map((item) => item.getBoundingClientRect()).map((box) => ({ top: box.top, height: box.height })));
    for (const box of boxes) expect(Math.abs(box.height - (boxes[0]?.height ?? 0)), "tile height").toBeLessThanOrEqual(1);
    for (const value of values) {
      expect(Math.abs(value.top - (values[0]?.top ?? 0)), "value top").toBeLessThanOrEqual(1);
      expect(Math.abs(value.height - (values[0]?.height ?? 0)), "value height").toBeLessThanOrEqual(1);
    }
  });
});

/** Descendants of `slot` (with a box) that stick out of it, by at most one pixel of rounding. */
async function outside(slot: Locator): Promise<string[]> {
  return slot.evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    const out: string[] = [];
    for (const element of root.querySelectorAll("*")) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.top < bounds.top - 1 || box.left < bounds.left - 1 || box.bottom > bounds.bottom + 1 || box.right > bounds.right + 1) out.push(`${element.tagName.toLowerCase()} ${(element.textContent ?? "").trim().slice(0, 40)}`);
    }
    return out;
  });
}

async function fitted(slot: Locator): Promise<void> {
  await expect(slot.locator("[data-fit-scale]")).toHaveAttribute("data-fit-scale", /\d/);
}

async function carouselStep(page: Page, index: number): Promise<Locator> {
  const region = page.locator('#tour [role="region"]');
  await region.evaluate((element, target) => {
    const article = element.querySelectorAll("article")[target];
    if (article instanceof HTMLElement && element instanceof HTMLElement) element.scrollTo({ left: article.offsetLeft - element.offsetLeft });
  }, index);
  const article = region.locator("article").nth(index);
  await article.evaluate((element) => element.scrollIntoView({ block: "start" }));
  return article.locator("[data-tour-visual]");
}

test.describe("[FL-127] conversación del hero en reposo", () => {
  test("[FL-127] opens the phone at the firm's question, whole, not cut under the header", async ({ page }, info) => {
    test.skip(!info.project.name.endsWith("-reduced"), "at rest from the start only with reduced motion");
    await page.goto(`/${langOf(info) === "en" ? "?lang=en" : ""}`);
    const screen = page.locator("[data-hero-visual] figure [role=group]");
    const anchor = screen.locator(`[data-message="${HERO_ANCHOR}"]`);
    await expect(anchor).toBeVisible();
    await expect
      .poll(async () => {
        const [box, bubble] = await Promise.all([screen.boundingBox(), anchor.boundingBox()]);
        return box && bubble ? bubble.y >= box.y && bubble.y - box.y < 40 : false;
      })
      .toBe(true);
  });
});

test.describe("[FL-127] recorrido sin recortes", () => {
  test("[FL-127] draws every step's visual whole inside its slot or the sticky stage", async ({ page }, info) => {
    await page.goto(`/${langOf(info) === "en" ? "?lang=en" : ""}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const mobile = info.project.name.startsWith("mobile");
    for (const [index, step] of TOUR_STEPS.entries()) {
      if (mobile) {
        const slot = await carouselStep(page, index);
        await fitted(slot);
        await expect.poll(() => outside(slot), { message: step.id }).toEqual([]);
        const [height, screen] = await slot.evaluate((element) => [element.getBoundingClientRect().height, window.innerHeight]);
        expect(height ?? 0, `${step.id}: at most 56 % of the screen`).toBeLessThanOrEqual((screen ?? 0) * 0.56 + 1);
        const box = await slot.boundingBox();
        expect((box?.x ?? 0) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= (page.viewportSize()?.width ?? 0), `${step.id}: inside the screen`).toBe(true);
      } else {
        await page.locator(`#${stepAnchor(step.id)}`).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await expect(page.locator(`#${stepAnchor(step.id)}`)).toHaveAttribute("aria-current", "step");
        const stage = page.locator("#tour [data-tour-stage]");
        await fitted(stage);
        await expect.poll(() => outside(stage), { message: step.id }).toEqual([]);
        await expect.poll(() => outside(stage.locator("xpath=..")), { message: `${step.id}: the stage's footer` }).toEqual([]);
      }
    }
  });
});
