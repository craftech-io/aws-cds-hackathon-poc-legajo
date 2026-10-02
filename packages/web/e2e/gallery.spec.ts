// FL-128 · the gallery with zoom (docs/landing-spec.md §6, ADR-0016 §5), in the six projects of
// docs/test-plan.md §3: a capture opens in a modal dialog that walks with its buttons, the arrow keys
// and a swipe, says "n de N" and the label of the capture's state, keeps the page from scrolling, and
// closes with Escape, the close button or a click outside the picture, giving the focus back to the
// thumbnail that opened it. No control and no caption ever covers the picture. On a desktop,
// "Ampliar" on a step of the tour opens its console capture.
import { readFileSync } from "node:fs";
import { type Page, type TestInfo, expect, test } from "@playwright/test";
import { LANDING_COPY, type LandingCopy } from "../src/views/landing/copy.ts";
import { GALLERY_IDS, LandingManifest } from "../src/views/landing/manifest.ts";
import { TOUR_STEPS, stepAnchor } from "../src/views/landing/tour-steps.ts";
import { blockExternalRequests } from "./support/assertions";

const manifest = LandingManifest.parse(JSON.parse(readFileSync(new URL("../public/landing/manifest.json", import.meta.url), "utf8")));
const captures = GALLERY_IDS.filter((id) => manifest.entries.some((entry) => entry.id === id && entry.status !== "render"));

function langOf(info: TestInfo): "es" | "en" {
  return /(^|-)en(-|$)/.test(info.project.name) ? "en" : "es";
}

async function openGallery(page: Page, info: TestInfo): Promise<LandingCopy> {
  const lang = langOf(info);
  await page.goto(`/${lang === "en" ? "?lang=en" : ""}#gallery`);
  await expect(page.locator("#gallery figure button").first()).toBeVisible();
  return LANDING_COPY[lang];
}

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

test.describe("[FL-128] galería con zoom y rótulo de origen", () => {
  test("[FL-128] walks the captures with the buttons, the keys and a swipe, labelled and counted", async ({ page }, info) => {
    expect(captures.length, "the gallery needs two pictures to walk").toBeGreaterThanOrEqual(2);
    const copy = await openGallery(page, info);
    await expect(page.locator("#gallery figure")).toHaveCount(captures.length);
    await page.locator("#gallery figure button").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(copy.zoom.counter(1, captures.length));
    await expect(dialog).toContainText(copy.media.items[captures[0] ?? "console-operations"].caption);
    await expect(dialog).toContainText(copy.gallery.localNote);
    await expect(page.locator("html")).toHaveClass(/overflow-hidden/);
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText(copy.zoom.counter(2, captures.length));
    await dialog.getByRole("button", { name: copy.zoom.next }).click();
    await expect(dialog).toContainText(copy.zoom.counter(3, captures.length));
    await dialog.getByRole("button", { name: copy.zoom.previous }).click();
    await expect(dialog).toContainText(copy.zoom.counter(2, captures.length));
    await page.keyboard.press("ArrowLeft");
    await expect(dialog).toContainText(copy.zoom.counter(1, captures.length));
    const picture = dialog.locator("img");
    await picture.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, clientX: 320, clientY: 400 });
    await picture.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, clientX: 120, clientY: 400 });
    await expect(dialog).toContainText(copy.zoom.counter(2, captures.length));
    await picture.dispatchEvent("pointerdown", { pointerType: "mouse", isPrimary: true, clientX: 320, clientY: 400 });
    await picture.dispatchEvent("pointerup", { pointerType: "mouse", isPrimary: true, clientX: 120, clientY: 400 });
    await expect(dialog, "a mouse drag is not a swipe").toContainText(copy.zoom.counter(2, captures.length));
  });

  test("[FL-128] closes with Escape, the close button and a click outside, and gives the focus back", async ({ page }, info) => {
    const copy = await openGallery(page, info);
    const thumbnail = page.locator("#gallery figure button").nth(1);
    const dialog = page.getByRole("dialog");
    await thumbnail.click();
    await expect(dialog).toBeVisible();
    const scrolled = await page.evaluate(() => window.scrollY);
    await page.mouse.move(8, 8);
    await page.mouse.wheel(0, 800);
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: "the page does not scroll under the dialog" }).toBe(scrolled);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(thumbnail).toBeFocused();
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrolled)).toBeLessThan(2);
    await expect(page.locator("html")).not.toHaveClass(/overflow-hidden/);
    await thumbnail.click();
    await dialog.getByRole("button", { name: copy.zoom.close }).click();
    await expect(dialog).toBeHidden();
    await expect(thumbnail).toBeFocused();
    await thumbnail.click();
    await page.mouse.click(8, 8);
    await expect(dialog).toBeHidden();
  });

  test("[FL-128] 'Ampliar' on a step of the tour opens the capture of the same moment", async ({ page }, info) => {
    test.skip(info.project.name.startsWith("mobile"), "the sticky stage exists from 1024 px");
    const copy = LANDING_COPY[langOf(info)];
    await page.goto(`/${langOf(info) === "en" ? "?lang=en" : ""}`);
    const step = TOUR_STEPS.find((candidate) => candidate.id === "reader");
    if (!step) throw new Error("the tour has no reader step");
    await page.locator(`#${stepAnchor(step.id)}`).evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(page.locator(`#${stepAnchor(step.id)}`)).toHaveAttribute("aria-current", "step");
    const enlarge = page.getByRole("button", { name: `${copy.tour.enlarge}: ${copy.media.items[step.capture].alt}` });
    await expect(enlarge).toBeVisible();
    // By keyboard: a pointer click would first scroll the sticky stage "into view" and move the tour.
    await enlarge.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText(copy.media.items[step.capture].caption);
  });

  test("[FL-128] never lays a control or the caption over the picture it shows", async ({ page }, info) => {
    await openGallery(page, info);
    await page.locator("#gallery figure button").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const picture = dialog.locator("img");
    await expect(picture).toBeVisible();
    await expect.poll(() => picture.evaluate((image) => (image as HTMLImageElement).complete)).toBe(true);
    const overlaps = await dialog.evaluate((root) => {
      const image = root.querySelector("img")?.getBoundingClientRect();
      if (!image) return ["no picture"];
      const covers = (box: DOMRect) => box.width > 0 && box.height > 0 && box.left < image.right - 1 && box.right > image.left + 1 && box.top < image.bottom - 1 && box.bottom > image.top + 1;
      const pieces = [...root.querySelectorAll("button"), ...root.querySelectorAll("[data-lightbox-caption], [data-lightbox-toolbar]")];
      return pieces.filter((piece) => covers(piece.getBoundingClientRect())).map((piece) => piece.getAttribute("aria-label") ?? piece.textContent?.trim().slice(0, 30) ?? piece.tagName);
    });
    expect(overlaps).toEqual([]);
    const box = await picture.boundingBox();
    const viewport = page.viewportSize();
    expect((box?.y ?? -1) >= 0 && (box?.y ?? 0) + (box?.height ?? 0) <= (viewport?.height ?? 0), "the picture starts and ends inside the screen").toBe(true);
  });

  test("[FL-128] on a phone, shows no text of the page around the picture", async ({ page }, info) => {
    test.skip(!info.project.name.startsWith("mobile"), "the backdrop is opaque below 640 px");
    await openGallery(page, info);
    await page.locator("#gallery figure button").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const backdrop = await dialog.evaluate((element) => getComputedStyle(element, "::backdrop").backgroundColor);
    expect(alphaOf(backdrop), backdrop).toBe(1);
  });
});

/** Alpha of a computed CSS colour (`rgb(…)`, `rgba(…, a)` or `oklab(… / a)`). */
function alphaOf(color: string): number {
  const slash = /\/\s*([\d.]+)\s*\)$/.exec(color);
  if (slash?.[1]) return Number(slash[1]);
  const parts = /^rgba?\(([^)]*)\)$/.exec(color)?.[1]?.split(",") ?? [];
  return parts.length === 4 ? Number(parts[3]) : color === "transparent" ? 0 : 1;
}
