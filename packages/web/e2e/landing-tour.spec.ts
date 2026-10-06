// FL-126 · the product tour and the landing's motion (docs/landing-spec.md §4), in the six projects of
// docs/test-plan.md §3: from 1024 px the sticky stage shows the step in the middle of the screen; on a
// phone the carousel moves with its buttons and with a swipe; the hero's conversation writes itself
// once and offers to play again; with reduced motion, or after "Pausar animaciones", nothing animates,
// the conversation is complete and every goal shows its value from the start.
import { type Page, type TestInfo, expect, test } from "@playwright/test";
import { heroMessages } from "../src/views/landing/conversations.ts";
import { LANDING_COPY, type LandingCopy } from "../src/views/landing/copy.ts";
import { TOUR_STEPS, stepAnchor } from "../src/views/landing/tour-steps.ts";
import { blockExternalRequests } from "./support/assertions";

function langOf(info: TestInfo): "es" | "en" {
  return /(^|-)en(-|$)/.test(info.project.name) ? "en" : "es";
}

const isMobile = (info: TestInfo) => info.project.name.startsWith("mobile");
const isReduced = (info: TestInfo) => info.project.name.endsWith("-reduced");

async function openLanding(page: Page, info: TestInfo, hash = ""): Promise<LandingCopy> {
  const lang = langOf(info);
  await page.goto(`/${lang === "en" ? "?lang=en" : ""}${hash}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return LANDING_COPY[lang];
}

/** Presses "Pausar animaciones" (inside the menu below 1280 px). */
async function pauseAnimations(page: Page, copy: LandingCopy): Promise<void> {
  const button = page.getByRole("button", { name: copy.motion.paused });
  if (!(await button.first().isVisible())) await page.getByRole("button", { name: copy.nav.menu }).click();
  await button.first().click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
}

async function expectStill(page: Page, copy: LandingCopy): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running").length)).toBe(0);
  await expect(page.locator("[data-hero-visual] figure ol > li")).toHaveCount(heroMessages().length + 1);
  await expect(page.getByRole("button", { name: copy.hero.replay })).toHaveCount(0);
  await page.locator("#impact").scrollIntoViewIfNeeded();
  await expect(page.locator("#impact")).toContainText(copy.impact.tiles.complete72h.value(72));
  await expect(page.locator("#impact")).toContainText(copy.impact.tiles.humanApproval.value(100));
}

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

test.describe("[FL-126] recorrido del producto y movimiento", () => {
  test("[FL-126] desktop: the sticky stage shows the step in the middle of the screen as the visitor scrolls", async ({ page }, info) => {
    test.skip(isMobile(info), "the sticky stage exists from 1024 px");
    const copy = await openLanding(page, info);
    const stage = page.locator("[data-tour-stage]").locator("xpath=..").locator("[aria-live=polite]");
    for (const step of [TOUR_STEPS[0], TOUR_STEPS[3], TOUR_STEPS[7]]) {
      if (!step) continue;
      await page.locator(`#${stepAnchor(step.id)}`).evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(stage).toHaveText(copy.tour.steps[step.id].title);
      await expect(page.locator(`#${stepAnchor(step.id)}`)).toHaveAttribute("aria-current", "step");
    }
  });

  test("[FL-126] from 768 px the step numbers stay stuck under the header while the steps go by, mark the current one, and are released after the last", async ({ page }, info) => {
    test.skip(isMobile(info), "the step numbers stick from 768 px; a phone has the carousel's own counter");
    const copy = await openLanding(page, info);
    const pills = page.locator("[data-tour-pills]");
    await expect(pills.getByRole("link")).toHaveCount(TOUR_STEPS.length);
    const header = await page.getByRole("banner").boundingBox();
    for (const [index, step] of TOUR_STEPS.entries()) {
      await page.locator(`#${stepAnchor(step.id)}`).evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
      const box = await pills.boundingBox();
      expect(box, `step ${index + 1}: the numbers are in view`).toBeTruthy();
      expect(box?.y ?? -1, `step ${index + 1}: stuck right under the header`).toBeGreaterThanOrEqual((header?.height ?? 0) - 1);
      // The first step may still show them in their own place, below the section's lead.
      if (index > 0) expect(box?.y ?? 999, `step ${index + 1}: stuck right under the header`).toBeLessThanOrEqual((header?.height ?? 0) + 2);
      await expect(pills.getByRole("link", { name: copy.tour.stepLabel(index + 1, TOUR_STEPS.length) })).toHaveAttribute("aria-current", "step");
      await expect(pills.locator("[aria-current=step]")).toHaveCount(1);
    }
    await page.locator("#capabilities").evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
    const released = await pills.boundingBox();
    expect((released?.y ?? 0) + (released?.height ?? 0), "after the last step the numbers are gone").toBeLessThanOrEqual(0);
  });

  test("[FL-126] desktop: the swap animates the stage alone, never a copy of the page", async ({ page }, info) => {
    test.skip(isMobile(info) || isReduced(info), "the stage swaps with a View Transition from 1024 px, with motion");
    await openLanding(page, info);
    await page.locator(`#${stepAnchor(TOUR_STEPS[0]?.id ?? "request")}`).evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.evaluate(() => {
      const seen = new Set<string>();
      (window as unknown as { __transitions: Set<string> }).__transitions = seen;
      const sample = () => {
        for (const animation of document.getAnimations()) {
          const pseudo = (animation.effect as KeyframeEffect | null)?.pseudoElement;
          if (pseudo?.startsWith("::view-transition")) seen.add(pseudo);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    for (const step of [TOUR_STEPS[1], TOUR_STEPS[3]]) {
      if (!step) continue;
      await page.locator(`#${stepAnchor(step.id)}`).evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(page.locator(`#${stepAnchor(step.id)}`)).toHaveAttribute("aria-current", "step");
    }
    await expect.poll(() => page.evaluate(() => [...(window as unknown as { __transitions: Set<string> }).__transitions].some((name) => name.includes("tour-stage")))).toBe(true);
    const names = await page.evaluate(() => [...(window as unknown as { __transitions: Set<string> }).__transitions]);
    expect(names.filter((name) => name.includes("(root)")), names.join(", ")).toEqual([]);
  });

  test("[FL-126] phone: the carousel moves with its buttons and with a swipe, and says the step", async ({ page }, info) => {
    test.skip(!isMobile(info), "the carousel exists below 768 px");
    const copy = await openLanding(page, info);
    const carousel = page.getByRole("region", { name: copy.tour.stepsLabel });
    await carousel.scrollIntoViewIfNeeded();
    const counter = page.getByText(copy.tour.stepLabel(1, TOUR_STEPS.length), { exact: true });
    await expect(counter).toBeVisible();
    await page.getByRole("button", { name: copy.tour.next }).click();
    await expect(page.getByText(copy.tour.stepLabel(2, TOUR_STEPS.length), { exact: true })).toBeVisible();
    await page.getByRole("button", { name: copy.tour.previous }).click();
    await expect(page.getByText(copy.tour.stepLabel(1, TOUR_STEPS.length), { exact: true })).toBeVisible();
    await carousel.evaluate((element) => element.scrollBy({ left: element.clientWidth * 2, behavior: "auto" }));
    await expect(page.getByText(copy.tour.stepLabel(3, TOUR_STEPS.length), { exact: true })).toBeVisible();
    await carousel.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText(copy.tour.stepLabel(4, TOUR_STEPS.length), { exact: true })).toBeVisible();
  });

  test("[FL-126] the hero's conversation writes itself once, from the real texts, and can be played again", async ({ page }, info) => {
    test.skip(isReduced(info), "with reduced motion it never plays");
    const copy = await openLanding(page, info);
    // It plays while the hero's phone is on screen (below the text on a phone).
    await page.locator("[data-hero-visual]").scrollIntoViewIfNeeded();
    const replay = page.getByRole("button", { name: copy.hero.replay });
    await expect(replay).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-hero-visual] figure ol > li")).toHaveCount(heroMessages().length + 1);
    await expect(page.locator("[data-hero-visual] figure ol")).toContainText(heroMessages()[0]?.text.slice(0, 40) ?? "");
    await replay.click();
    await expect(replay).toHaveCount(0);
    await expect(replay).toBeVisible({ timeout: 15_000 });
  });

  test("[FL-126] with reduced motion or after 'Pausar animaciones' nothing moves and everything is in its final state", async ({ page }, info) => {
    const copy = await openLanding(page, info);
    if (!isReduced(info)) await pauseAnimations(page, copy);
    await expectStill(page, copy);
    if (isReduced(info)) return;
    await page.reload();
    await expect(page.locator("html"), "the pause holds for the session").toHaveAttribute("data-motion", "off");
    await expectStill(page, copy);
  });
});
