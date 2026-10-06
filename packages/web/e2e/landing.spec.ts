// FL-089 · the commercial landing, bilingual (docs/landing-spec.md §1.2, §2, §5.4), in the six projects of
// docs/test-plan.md §3: the twelve sections in order with one `h1`, the language switch that changes the
// document's `lang`, its title and every text and keeps the choice, "Probar Legajo listo" in the header, the
// hero and the closing, the questions operable with the keyboard, the footer's legal pages, the static
// robots.txt and no `noindex` on `/`. The page's text is checked against the neutral words of ADR-0014
// (the list frame-check.ts applies to every capture) and every request stays on the machine.
import { type Page, type TestInfo, expect, test } from "@playwright/test";
import { findNeutralHits } from "../../../scripts/lint/neutral-words.ts";
import { LANDING_COPY, type LandingCopy } from "../src/views/landing/copy.ts";
import { blockExternalRequests } from "./support/assertions";

const SECTION_ORDER = ["top", "problem", "video", "tour", "capabilities", "guarantees", "impact", "integrations", "architecture", "faq", "gallery", "start"];

const LANGUAGE_NAMES = { es: "Español", en: "English" } as const;

function langOf(info: TestInfo): "es" | "en" {
  return /(^|-)en(-|$)/.test(info.project.name) ? "en" : "es";
}

function inLang(path: string, lang: "es" | "en"): string {
  return lang === "en" ? `${path}${path.includes("?") ? "&" : "?"}lang=en` : path;
}

async function openLanding(page: Page, info: TestInfo): Promise<LandingCopy> {
  const lang = langOf(info);
  await page.goto(inLang("/", lang));
  await expect(page.getByRole("heading", { level: 1, name: LANDING_COPY[lang].hero.title })).toBeVisible();
  return LANDING_COPY[lang];
}

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

test.describe("[FL-089] landing comercial bilingüe", () => {
  test("[FL-089] shows the twelve sections in order, one page heading, its language and the synthetic-data notes", async ({ page }, info) => {
    const copy = await openLanding(page, info);
    expect(await page.locator("main > section").evaluateAll((sections) => sections.map((section) => section.id))).toEqual(SECTION_ORDER);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("lang", copy.meta.code);
    await expect(page).toHaveTitle(copy.meta.title);
    await expect(page.getByText(copy.hero.note)).toBeVisible();
    await expect(page.getByText(copy.footer.synthetic)).toBeVisible();
    for (const section of ["problem", "video", "tour", "guarantees", "impact", "integrations", "architecture", "faq", "gallery"] as const) {
      await expect(page.locator(`#${section}`).getByRole("heading", { level: 2 })).toHaveText(copy[section].title);
    }
    // The video waits for the visitor: no autoplay, nothing downloaded before play, a poster and controls.
    const video = page.locator("#video video");
    await expect(video).toHaveAttribute("preload", "none");
    await expect(video).toHaveAttribute("poster", /legajo-listo-poster\.jpg$/);
    expect(await video.evaluate((element: HTMLVideoElement) => ({ autoplay: element.autoplay, controls: element.controls }))).toEqual({ autoplay: false, controls: true });
    expect(findNeutralHits(await page.locator("body").innerText())).toEqual([]);
  });

  test("[FL-089] the selector shows the current language and turns every text to the other, with its lang and title, and keeps the choice", async ({ page }, info) => {
    const lang = langOf(info);
    const other = lang === "es" ? "en" : "es";
    const copy = await openLanding(page, info);
    const next = LANDING_COPY[other];
    const group = page.getByRole("group", { name: copy.lang.label });
    if (!(await group.first().isVisible())) await page.getByRole("button", { name: copy.nav.menu }).click();
    const selector = group.first();
    await expect(selector.getByRole("button", { name: LANGUAGE_NAMES[lang] }), "the current language is the one filled in").toHaveAttribute("aria-pressed", "true");
    await expect(selector.getByRole("button", { name: LANGUAGE_NAMES[lang] })).toHaveAttribute("aria-current", "true");
    await expect(selector.getByRole("button", { name: LANGUAGE_NAMES[other] })).toHaveAttribute("aria-pressed", "false");
    for (const button of await selector.getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(Math.min(box?.width ?? 0, box?.height ?? 0), "a 44 px touch target").toBeGreaterThanOrEqual(43.5);
    }
    await selector.getByRole("button", { name: LANGUAGE_NAMES[other] }).click();
    await expect(page.getByRole("heading", { level: 1, name: next.hero.title })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", next.meta.code);
    await expect(page).toHaveTitle(next.meta.title);
    await expect(page.locator("#impact h2")).toHaveText(next.impact.title);
    expect(new URL(page.url()).searchParams.get("lang")).toBe(other === "en" ? "en" : null);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: next.hero.title }), "the last choice wins without a parameter").toBeVisible();
  });

  test("[FL-089] the header's selector fits next to 'Ingresar' and the call to action without overlapping", async ({ page }, info) => {
    test.skip(info.project.name.startsWith("mobile"), "below 768 px the selector lives in the menu");
    const copy = await openLanding(page, info);
    const header = page.getByRole("banner");
    const lang = await header.getByRole("group", { name: copy.lang.label }).boundingBox();
    const signIn = await header.getByRole("link", { name: copy.cta.signIn }).boundingBox();
    const cta = await header.getByRole("link", { name: copy.cta.try }).boundingBox();
    if (!lang || !signIn || !cta) throw new Error("the header lacks the selector, 'Ingresar' or the call to action");
    expect(lang.x + lang.width, "the selector ends before 'Ingresar'").toBeLessThanOrEqual(signIn.x);
    expect(signIn.x + signIn.width, "'Ingresar' ends before the call to action").toBeLessThanOrEqual(cta.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("[FL-089] the header highlights the link of the section in view (aria-current) as the visitor scrolls", async ({ page }, info) => {
    const copy = await openLanding(page, info);
    const mobile = info.project.name.startsWith("mobile");
    const header = page.getByRole("banner");
    if (mobile) await page.getByRole("button", { name: copy.nav.menu }).click();
    for (const [section, name] of [
      ["guarantees", copy.nav.guarantees],
      ["faq", copy.nav.faq],
      ["architecture", copy.nav.architecture],
    ] as const) {
      // The pictures above still settle while the page loads: scroll again until the section holds the band.
      await expect(async () => {
        await page.evaluate((id) => {
          const target = document.getElementById(id);
          if (target) window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.375 + 40, behavior: "instant" });
        }, section);
        await expect(header.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "location", { timeout: 1500 });
      }).toPass({ timeout: 15_000 });
      await expect(header.locator("[aria-current=location]:visible")).toHaveCount(1);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expect(header.locator("[aria-current=location]:visible")).toHaveCount(0);
  });

  test("[FL-089] the architecture section shows the connected diagram with its size, lazy loading, alt text and a link to open it full size", async ({ page }, info) => {
    const lang = langOf(info);
    const copy = await openLanding(page, info);
    const figure = page.locator("#architecture-diagram");
    const image = figure.locator("img");
    await expect(image).toHaveAttribute("width", "1920");
    await expect(image).toHaveAttribute("height", "1380");
    await expect(image).toHaveAttribute("loading", "lazy");
    await expect(image).toHaveAttribute("alt", copy.architecture.diagram.alt);
    expect(findNeutralHits(copy.architecture.diagram.alt)).toEqual([]);
    await figure.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => (element.complete && element.naturalWidth > 0 ? element.currentSrc : ""))).toMatch(new RegExp(`/landing/architecture/architecture-${lang}-(1920|3840)\\.webp$`));
    const open = figure.getByRole("link", { name: copy.architecture.diagram.open });
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("href", `/landing/architecture/architecture-${lang}-3840.webp`);
    expect((await page.request.get(`/landing/architecture/architecture-${lang}-3840.webp`)).status()).toBe(200);
  });

  test("[FL-089] 'Probar Legajo listo' is the call to action of the header, the hero and the closing, all to /signup", async ({ page }, info) => {
    const copy = await openLanding(page, info);
    await expect(page.getByRole("banner").getByRole("link", { name: copy.cta.try })).toHaveAttribute("href", "/signup");
    await expect(page.locator("#top").getByRole("link", { name: copy.hero.primary })).toHaveAttribute("href", "/signup");
    await expect(page.locator("#start").getByRole("link", { name: copy.closing.try })).toHaveAttribute("href", "/signup");
    const robots = await page.locator('meta[name="robots"]').count();
    expect(robots, "/ is indexable").toBe(0);
  });

  test("[FL-089] serves the static robots.txt: the landing and the legal pages indexable, access and console out", async ({ page }) => {
    const response = await page.request.get("/robots.txt");
    expect(response.status()).toBe(200);
    const body = await response.text();
    for (const line of ["Allow: /", "Allow: /legal/", "Disallow: /app/", "Disallow: /signup", "Disallow: /login", "Disallow: /forgot", "Disallow: /welcome"]) expect(body).toContain(line);
  });

  test("[FL-089] opens and closes the six questions with the keyboard, and links the legal pages from the footer", async ({ page }, info) => {
    const copy = await openLanding(page, info);
    const questions = page.locator("#faq details");
    await expect(questions).toHaveCount(6);
    const first = questions.first();
    await first.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("open", "");
    await expect(first).toContainText(copy.faq.data.a);
    await page.keyboard.press("Enter");
    await expect(first).not.toHaveAttribute("open", "");
    const legal = page.getByRole("contentinfo").getByRole("navigation", { name: copy.footer.legal });
    await expect(legal.getByRole("link", { name: copy.footer.privacy })).toHaveAttribute("href", "/legal/privacy.html");
    await expect(legal.getByRole("link", { name: copy.footer.terms })).toHaveAttribute("href", "/legal/terms.html");
  });
});

/** The page and the sign-in screen a first-time visitor reaches with no `?lang` and, optionally, a stored choice. */
async function firstVisit(page: Page, stored?: "es" | "en"): Promise<{ landing: string | null; title: string; login: string | null }> {
  if (stored) await page.addInitScript((value) => window.localStorage.setItem("legajo.lang", value), stored);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const landing = await page.locator("html").getAttribute("lang");
  const title = await page.getByRole("heading", { level: 1 }).innerText();
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", /^(es-AR|en)$/);
  return { landing, title, login: await page.locator("html").getAttribute("lang") };
}

test.describe("[FL-120] idioma por defecto = el del navegador", () => {
  test.describe("Spanish browser", () => {
    test.use({ locale: "es-MX" });
    test("[FL-120] any es* opens the landing and the sign-in screen in Spanish", async ({ page }) => {
      expect(await firstVisit(page)).toEqual({ landing: "es-AR", title: LANDING_COPY.es.hero.title, login: "es-AR" });
    });
  });

  test.describe("French browser", () => {
    test.use({ locale: "fr-FR" });
    test("[FL-120] a browser with no Spanish opens both in English", async ({ page }) => {
      expect(await firstVisit(page)).toEqual({ landing: "en", title: LANDING_COPY.en.hero.title, login: "en" });
    });
  });

  test.describe("explicit choice", () => {
    test.use({ locale: "es-AR" });
    test("[FL-120] the visitor's stored choice beats the browser's language, on the landing and on sign-in", async ({ page }) => {
      expect(await firstVisit(page, "en")).toEqual({ landing: "en", title: LANDING_COPY.en.hero.title, login: "en" });
    });
  });
});
