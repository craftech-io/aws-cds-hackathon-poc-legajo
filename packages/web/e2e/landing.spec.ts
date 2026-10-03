// FL-089 · the commercial landing, bilingual (docs/landing-spec.md §1.2, §2, §5.4), in the six projects of
// docs/test-plan.md §3: the eleven sections in order with one `h1`, the language switch that changes the
// document's `lang`, its title and every text and keeps the choice, "Probar Legajo listo" in the header, the
// hero and the closing, the questions operable with the keyboard, the footer's legal pages, the static
// robots.txt and no `noindex` on `/`. The page's text is checked against the neutral words of ADR-0014
// (the list frame-check.ts applies to every capture) and every request stays on the machine.
import { type Page, type TestInfo, expect, test } from "@playwright/test";
import { findNeutralHits } from "../../../scripts/lint/neutral-words.ts";
import { LANDING_COPY, type LandingCopy } from "../src/views/landing/copy.ts";
import { blockExternalRequests } from "./support/assertions";

const SECTION_ORDER = ["top", "problem", "tour", "capabilities", "guarantees", "impact", "integrations", "architecture", "faq", "gallery", "start"];

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
  test("[FL-089] shows the eleven sections in order, one page heading, its language and the synthetic-data notes", async ({ page }, info) => {
    const copy = await openLanding(page, info);
    expect(await page.locator("main > section").evaluateAll((sections) => sections.map((section) => section.id))).toEqual(SECTION_ORDER);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("lang", copy.meta.code);
    await expect(page).toHaveTitle(copy.meta.title);
    await expect(page.getByText(copy.hero.note)).toBeVisible();
    await expect(page.getByText(copy.footer.synthetic)).toBeVisible();
    for (const section of ["problem", "tour", "guarantees", "impact", "integrations", "architecture", "faq", "gallery"] as const) {
      await expect(page.locator(`#${section}`).getByRole("heading", { level: 2 })).toHaveText(copy[section].title);
    }
    expect(findNeutralHits(await page.locator("body").innerText())).toEqual([]);
  });

  test("[FL-089] the switch turns every text to the other language, with its lang and title, and keeps the choice", async ({ page }, info) => {
    const lang = langOf(info);
    const other = lang === "es" ? "en" : "es";
    const copy = await openLanding(page, info);
    const toggle = page.getByRole("button", { name: copy.lang.switchLabel }).first();
    if (!(await toggle.isVisible())) await page.getByRole("button", { name: copy.nav.menu }).click();
    await page.getByRole("button", { name: copy.lang.switchLabel }).first().click();
    const next = LANDING_COPY[other];
    await expect(page.getByRole("heading", { level: 1, name: next.hero.title })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", next.meta.code);
    await expect(page).toHaveTitle(next.meta.title);
    await expect(page.locator("#impact h2")).toHaveText(next.impact.title);
    expect(new URL(page.url()).searchParams.get("lang")).toBe(other === "en" ? "en" : null);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: next.hero.title }), "the last choice wins without a parameter").toBeVisible();
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
