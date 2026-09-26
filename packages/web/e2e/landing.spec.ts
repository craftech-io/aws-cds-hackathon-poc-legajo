// FL-089 · the bilingual landing and the legal pages of the demo (docs/flows-catalog.md), on the UI
// server's Vite: the story with the real texts, "Powered by Craftech", the synthetic-data notice and
// the block of what is real and what is simulated, the es/en switch, the scenes, the gallery with zoom
// (buttons, keys, swipe, Escape), the judges' button to the login and the two legal pages. Every
// request stays on the machine.
import { readFileSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import { JUDGES_SIGN_IN, LANDING_COPY } from "../src/views/landing/copy.ts";
import { LandingManifest, mediaIdsIn } from "../src/views/landing/manifest.ts";
import { SCENES } from "../src/views/landing/scenes.ts";
import { loginCopy } from "../src/views/login/copy.ts";
import { RAW_CODE, blockExternalRequests, expectAccessibleBasics } from "./support/assertions";

const es = LANDING_COPY.es;
const en = LANDING_COPY.en;
const manifest = LandingManifest.parse(JSON.parse(readFileSync(new URL("../public/landing/manifest.json", import.meta.url), "utf8")));
const pictures = mediaIdsIn(manifest).length;

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

/** No enum value or id a person would read; the story's email addresses are what a reader sees. */
async function expectNoRawCodesOnLanding(page: Page): Promise<void> {
  const text = (await page.locator("body").innerText()).replace(/[\w.+*-]+@[\w.-]+/g, "");
  expect(text).not.toMatch(RAW_CODE);
}

function heroTitle(page: Page, lang: "es" | "en") {
  return page.getByRole("heading", { level: 1, name: LANDING_COPY[lang].hero.title });
}

test.describe("[FL-089] landing bilingüe y páginas legales", () => {
  test("[FL-089] the landing tells the story in Spanish, Powered by Craftech, with synthetic data and what is real and what is simulated", async ({ page }) => {
    await page.goto("/");
    await expect(heroTitle(page, "es")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "es-AR");
    await expect(page.getByText("Legajo listo", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Powered by/ }).first()).toHaveAttribute("href", "https://craftech.io");
    await expect(page.getByText(es.hero.note)).toBeVisible();
    await expect(page.getByText(es.footer.synthetic)).toBeVisible();

    const real = page.getByRole("region", { name: es.real.title });
    for (const column of Object.values(es.real.columns)) await expect(real.getByRole("heading", { name: column.title })).toBeVisible();
    await expect(real).toContainText(es.real.columns.simulated.text);
    // The phone is always labelled a simulator.
    await expect(page.getByText(es.phone.simulator).first()).toBeVisible();

    await expectAccessibleBasics(page);
    await expectNoRawCodesOnLanding(page);
  });

  test("[FL-089] the switch turns the page to English and keeps it in the address, so a shared link opens in it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: es.lang.switchLabel }).click();
    await expect(heroTitle(page, "en")).toBeVisible();
    await expect(page).toHaveURL(/\/\?lang=en$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("region", { name: en.real.title })).toContainText(en.real.columns.simulated.text);
    // WhatsApp stays in Spanish, with its English gloss shown on the English page.
    await expect(page.getByRole("button", { name: en.phone.glossToggle }).first()).toHaveAttribute("aria-pressed", "true");
    await expectAccessibleBasics(page);
    await expectNoRawCodesOnLanding(page);

    await page.reload();
    await expect(heroTitle(page, "en")).toBeVisible();
    await page.getByRole("button", { name: en.lang.switchLabel }).click();
    await expect(heroTitle(page, "es")).toBeVisible();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    await expect(page.getByRole("button", { name: es.phone.glossToggle }).first()).toHaveAttribute("aria-pressed", "false");
  });

  test("[FL-089] the scenes of the story move by tab, by previous and next, and by keyboard", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#story");
    const tabs = page.getByRole("tablist", { name: es.story.tabsLabel }).getByRole("tab");
    const panel = page.getByRole("tabpanel");
    await expect(tabs).toHaveCount(SCENES.length);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("heading", { name: es.story.scenes.request.title })).toBeVisible();
    // With reduced motion nothing advances on its own.
    await expect(panel.getByRole("button", { name: es.story.play })).toHaveAttribute("aria-pressed", "false");

    await tabs.nth(1).click();
    await expect(panel.getByRole("heading", { name: es.story.scenes.delegate.title })).toBeVisible();
    await expect(panel.getByText(es.story.deferrals.supplierHours)).toBeVisible();
    await expect(panel.getByText("CP-HOURS-SUPPLIER")).toBeVisible();

    await panel.getByRole("button", { name: new RegExp(es.story.next) }).click();
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("list", { name: es.email.threadLabel })).toBeVisible();
    await panel.getByRole("button", { name: new RegExp(es.story.previous) }).click();
    await expect(panel.getByRole("heading", { name: es.story.scenes.delegate.title })).toBeVisible();

    await tabs.nth(1).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(2)).toBeFocused();
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(panel.getByRole("heading", { name: es.story.scenes.policy.title })).toBeVisible();
    await expect(panel.getByText("CED-NO-APPROVE")).toBeVisible();
    await expectAccessibleBasics(page);
  });

  test("[FL-089] the gallery zooms a picture and walks it with buttons, keys and a swipe, and Escape closes it", async ({ page }) => {
    expect(pictures, "the gallery needs two pictures to walk").toBeGreaterThanOrEqual(2);
    await page.goto("/#console");
    const section = page.getByRole("region", { name: es.console.title });
    await section.getByRole("button", { name: new RegExp(`^${es.zoom.open}`) }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(es.zoom.counter(1, pictures));

    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText(es.zoom.counter(2, pictures));
    await page.keyboard.press("ArrowLeft");
    await expect(dialog).toContainText(es.zoom.counter(1, pictures));
    await dialog.getByRole("button", { name: es.zoom.next }).click();
    await expect(dialog).toContainText(es.zoom.counter(2, pictures));
    await dialog.getByRole("button", { name: es.zoom.previous }).click();
    await expect(dialog).toContainText(es.zoom.counter(1, pictures));

    // A swipe to the left on a touch screen shows the next picture.
    const picture = dialog.getByRole("img");
    await picture.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, clientX: 320, clientY: 400 });
    await picture.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, clientX: 120, clientY: 400 });
    await expect(dialog).toContainText(es.zoom.counter(2, pictures));

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("[FL-089] Judges: sign in / Jurado: ingresar opens the login", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("region", { name: es.judges.title }).getByRole("link", { name: `${JUDGES_SIGN_IN} →` }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { level: 1, name: loginCopy.credentials.title })).toBeVisible();
  });

  test("[FL-089] the legal pages of the demo answer in Spanish and English, from the landing's footer", async ({ page }) => {
    const pages = [
      { link: es.footer.privacy, path: "/legal/privacy.html", titles: ["Política de privacidad", "Privacy policy"] },
      { link: es.footer.terms, path: "/legal/terms.html", titles: ["Términos y condiciones", "Terms and conditions"] },
    ] as const;
    for (const legal of pages) {
      await page.goto("/");
      await page.getByRole("navigation", { name: es.footer.legal }).getByRole("link", { name: legal.link }).click();
      await expect(page).toHaveURL(new RegExp(`${legal.path.replace(/\./g, "\\.")}$`));
      await expect(page.getByRole("heading", { level: 1, name: legal.titles[0] })).toBeVisible();
      await expect(page.locator("#en").getByRole("heading", { level: 1, name: legal.titles[1] })).toBeVisible();
      await expect(page.getByRole("link", { name: /Powered by/ })).toHaveAttribute("href", "https://craftech.io");
      expect(await page.locator("script").count()).toBe(0);
      const response = await page.request.get(legal.path);
      expect(response.status()).toBe(200);
    }
  });
});
