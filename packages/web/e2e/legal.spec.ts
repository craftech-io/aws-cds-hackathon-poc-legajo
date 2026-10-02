// FL-089 · FL-119 · the two legal pages of the demo (ADR-0015 §8, docs/landing-spec.md §8.9) as a
// visitor opens them from the landing, from a box of the sign-up form or from a shared link: Spanish
// and English on one static page, each with the version in force on top (the one a lead stores,
// LEGAL_VERSIONS), readable from 360 px without horizontal scroll, AA contrast, no script, nothing
// loaded from another host, and no word of the neutral list or of the external forbidden list in
// what a reader sees. Served by the UI server's Vite from packages/web/public; nothing leaves the
// machine.
import { type Page, expect, test } from "@playwright/test";
import { frameProblems, termsFor } from "../../../scripts/landing/frame-check";
import { findNeutralHits } from "../../../scripts/lint/neutral-words";
import { CONSENT_KINDS, SIGNUP_CONSENT_TEXTS, consentPlainText, legalPageHref } from "../../shared/src/consent-texts.ts";
import { LEGAL_PAGE_PATHS, LEGAL_VERSIONS, type LegalPage } from "../../shared/src/legal-versions.ts";
import { blockExternalRequests } from "./support/assertions";

const PAGES: readonly LegalPage[] = ["privacy", "terms"];
const LANGS = ["es", "en"] as const;
/** Narrowest width of the standard (360 px) and the widest desktop the specs use. */
const WIDTHS = [360, 1440] as const;

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

/** A fresh load, as from a shared link (a fragment change on the open page would not load it again). */
async function open(page: Page, name: LegalPage, hash = ""): Promise<void> {
  await page.goto("about:blank");
  const response = await page.goto(`${LEGAL_PAGE_PATHS[name]}${hash}`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"] ?? "").toContain("text/html");
}

/** Text pairs below WCAG 2.2 AA (4.5:1, or 3:1 for large text) among the elements a reader sees. */
function contrastFailures(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Rgba = { r: number; g: number; b: number; a: number };
    const parse = (value: string): Rgba | undefined => {
      const parts = /rgba?\(([^)]+)\)/.exec(value)?.[1]?.split(/[\s,/]+/).filter(Boolean).map(Number);
      if (!parts || parts.length < 3) return undefined;
      return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
    };
    const channel = (value: number) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: Rgba) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    const backgroundOf = (element: Element): Rgba => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0) return color;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const failures: string[] = [];
    for (const element of document.querySelectorAll("body *")) {
      const text = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join("").trim();
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (text === "" || box.width === 0 || box.height === 0 || style.visibility === "hidden") continue;
      const foreground = parse(style.color);
      if (!foreground) continue;
      const [light, dark] = [luminance(foreground), luminance(backgroundOf(element))].sort((a, b) => b - a);
      const ratio = ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (Number(style.fontWeight) >= 700 && size >= 18.66);
      if (ratio < (large ? 3 : 4.5)) failures.push(`${element.tagName.toLowerCase()} "${text.slice(0, 40)}" ${ratio.toFixed(2)}:1`);
    }
    return failures;
  });
}

test.describe("[FL-089] [FL-119] páginas legales con su versión", () => {
  for (const name of PAGES) {
    test(`[FL-089] [FL-119] ${name}: Spanish and English on one page, each with the version in force on top`, async ({ page }) => {
      await open(page, name);
      await expect(page.locator("html")).toHaveAttribute("lang", "es");
      expect(await page.locator("script").count()).toBe(0);

      for (const lang of LANGS) {
        const doc = page.locator(`section#${lang}`);
        await expect(doc).toHaveAttribute("lang", lang);
        const title = doc.getByRole("heading", { level: 1 });
        await expect(title).toHaveCount(1);
        await expect(title).not.toBeEmpty();
        const version = doc.locator(`[data-legal-version="${name}"]`);
        await expect(version).toHaveText(LEGAL_VERSIONS[name]);
        await expect(doc.locator("time").first()).toHaveAttribute("datetime", LEGAL_VERSIONS[name]);
        await version.scrollIntoViewIfNeeded();
        await expect(version).toBeVisible();
        // On top: before the first section of the document.
        const versionBox = await version.boundingBox();
        const firstSection = await doc.getByRole("heading", { level: 2 }).first().boundingBox();
        expect(versionBox && firstSection && versionBox.y < firstSection.y).toBe(true);
      }

      const text = await page.locator("body").innerText();
      expect(frameProblems(text, termsFor(false))).toEqual([]);
      await expect(page.getByRole("link", { name: /Powered by/ })).toHaveAttribute("href", "https://craftech.io");
    });

    test(`[FL-089] ${name}: the language links jump to each version and a shared link opens the English one`, async ({ page }) => {
      await open(page, name);
      const languages = page.getByRole("navigation", { name: /Idioma/ });
      await languages.getByRole("link", { name: "English" }).click();
      await expect(page).toHaveURL(/#en$/);
      await expect(page.locator("section#en h1")).toBeInViewport();
      await languages.getByRole("link", { name: "Español" }).click();
      await expect(page).toHaveURL(/#es$/);
      await expect(page.locator("section#es h1")).toBeInViewport();

      await open(page, name, "#en");
      await expect(page.locator("section#en h1")).toBeInViewport();
    });

    for (const width of WIDTHS) {
      test(`[FL-089] ${name}: readable at ${width} px without horizontal scroll and with AA contrast`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        for (const lang of LANGS) {
          await open(page, name, `#${lang}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, `${lang} at ${width} px`).toBeLessThanOrEqual(0);
          const bodySize = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).fontSize));
          expect(bodySize).toBeGreaterThanOrEqual(16);
        }
        expect(await contrastFailures(page)).toEqual([]);
      });
    }
  }
});

test.describe("[FL-119] casillas del alta y legales", () => {
  test("[FL-119] the links of the terms box open each legal page at the section of the form's language", async ({ page }) => {
    for (const lang of LANGS) {
      for (const run of SIGNUP_CONSENT_TEXTS.terms[lang]) {
        if (run.link === undefined) continue;
        await page.goto("about:blank");
        const response = await page.goto(legalPageHref(run.link, lang));
        expect(response?.status()).toBe(200);
        await expect(page.locator(`section#${lang} h1`)).toBeInViewport();
        await expect(page.locator(`section#${lang} [data-legal-version="${run.link}"]`)).toHaveText(LEGAL_VERSIONS[run.link]);
      }
    }
  });

  test("[FL-119] the words of both boxes are neutral in both languages", () => {
    for (const kind of CONSENT_KINDS) {
      for (const lang of LANGS) expect(findNeutralHits(consentPlainText(kind, lang)), `${kind} ${lang}`).toEqual([]);
    }
  });
});
