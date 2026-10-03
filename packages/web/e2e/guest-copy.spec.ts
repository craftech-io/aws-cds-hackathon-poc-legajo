// FL-131 · the visible texts of the console and of the guided tour for a guest (docs/flows-catalog.md;
// ADR-0014 §2 and §8; docs/landing-spec.md D-09). A visitor who signed up alone opens its own world
// (built from the `guest` template on the local UI server) and walks every view of the console, the
// dossier of 4471, the "Recorrido guiado" panel in Spanish and English, the account menu and the notice
// a second session gets. The text each one shows at run time (its `innerText`, data included) goes
// through the same matcher as the neutral-surfaces guard and the frame check (scripts/lint/neutral-words.ts),
// and none of it may show an internal account id, the visitor's email or the app's internal name. The
// role reads "Invitado". Every project of the public surfaces runs it. Nothing leaves the machine.
import { type Page, expect, test } from "@playwright/test";
import { findNeutralHits } from "../../../scripts/lint/neutral-words.ts";
import { createVerifiedGuest, inLang, routeCognitoToServer, specLang, testMailbox, testViewerIp, useViewerIp } from "../../../tests/ui-server/auth/browser-helpers.ts";
import { copy } from "../src/copy/console.ts";
import { type RouteId } from "../src/routes.ts";
import { AUTH_COPY } from "../src/views/auth/copy.ts";
import { operationsCopy } from "../src/views/operations/copy.ts";
import { TOUR_TEXTS } from "../src/views/tour/copy.ts";
import { blockExternalRequests, expectView } from "./support/assertions";
import { UI_SERVER_URL } from "./support/env";

// Fixture password of the in-memory pool: it never leaves this machine.
const PASSWORD = "Clave-de-Prueba-2026!";
const CONSOLE = /\/app\/operations/;
/** Internal names a person must never read: an account id of the pool, the app's resource prefix. */
const INTERNAL = [/\busr-[0-9a-z]{6,}/i, /aws-cds/i, /legajo-poc-/i];
const VIEWS: readonly RouteId[] = ["operations", "escalations", "registry", "simulator", "mailbox", "clock", "metrics", "audit"];

let blocked: string[];

test.beforeEach(async ({ page }, info) => {
  blocked = await blockExternalRequests(page);
  await routeCognitoToServer(page, UI_SERVER_URL);
  await useViewerIp(page, testViewerIp(info));
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

async function signIn(page: Page, email: string, lang: "es" | "en"): Promise<void> {
  const login = AUTH_COPY[lang].login;
  await page.goto(inLang("/login", lang));
  await page.getByLabel(login.login).fill(email);
  await page.getByLabel(login.password, { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: login.submit }).click();
  await expect(page).toHaveURL(CONSOLE, { timeout: 30_000 });
}

/** What the page shows once its data has landed. */
async function visibleText(page: Page): Promise<string> {
  await page.waitForLoadState("networkidle");
  return page.locator("body").innerText();
}

function expectGuestSafe(text: string, where: string, email: string): void {
  expect(findNeutralHits(text), `${where}: words of the neutral-surfaces guard`).toEqual([]);
  expect(text.toLowerCase().includes(email.toLowerCase()), `${where}: the visitor's email`).toBe(false);
  for (const pattern of INTERNAL) expect(text, `${where}: an internal name`).not.toMatch(pattern);
}

/** The tour panel, opened if the layout keeps it closed. */
async function tourPanel(page: Page) {
  const panel = page.getByRole("complementary", { name: copy.tour.title });
  if (!(await panel.isVisible())) await page.getByRole("button", { name: copy.tour.open }).click();
  await expect(panel).toBeVisible();
  return panel;
}

test.describe("[FL-131] the console of a guest who signed up alone", () => {
  test("[FL-131] every view, the dossier, the tour in both languages and the account menu read without the guarded words or internal names", async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const lang = specLang(info);
    const email = testMailbox(info, "gc");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await signIn(page, email, lang);
    await expect(page.getByText(`${copy.app.roleLabel}: ${copy.roles.GUEST}`)).toBeVisible();

    for (const view of VIEWS) {
      await page.goto(`/app/${view}`);
      await expectView(page, view);
      expectGuestSafe(await visibleText(page), view, email);
    }

    await page.goto("/app/operations");
    await expectView(page, "operations");
    // The dossier's own link, followed by address: on the touch phone project a tap on the list misses it.
    await page.goto((await page.getByRole("link", { name: operationsCopy.openDossier("4471") }).first().getAttribute("href")) ?? "");
    await expectView(page, "dossier");
    expectGuestSafe(await visibleText(page), "dossier", email);

    const panel = await tourPanel(page);
    await expect(panel).toContainText(TOUR_TEXTS.es.intro);
    expectGuestSafe(await panel.innerText(), "tour (es)", email);
    await panel.getByRole("button", { name: "EN", exact: true }).click();
    await expect(panel).toContainText(TOUR_TEXTS.en.intro);
    expectGuestSafe(await panel.innerText(), "tour (en)", email);

    await page.getByRole("button", { name: copy.account.menu }).click();
    await expect(page.getByRole("button", { name: copy.account.changePassword })).toHaveCount(0);
    await expect(page.getByRole("button", { name: copy.account.totp })).toHaveCount(0);
    expectGuestSafe(await visibleText(page), "account menu", email);
  });

  test("[FL-131] the notice a second session of the same guest gets reads without the guarded words", async ({ page, browser, request }, info) => {
    const lang = specLang(info);
    const email = testMailbox(info, "gs");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await signIn(page, email, lang);
    await visibleText(page);

    const { baseURL, locale, timezoneId, viewport } = test.info().project.use;
    const other = await browser.newContext({ baseURL, locale, timezoneId, ...(viewport ? { viewport } : {}) });
    const second = await other.newPage();
    const secondBlocked = await blockExternalRequests(second);
    await routeCognitoToServer(second, UI_SERVER_URL);
    await useViewerIp(second, testViewerIp(info));
    await signIn(second, email, lang);
    const notice = second.getByRole("alert").filter({ hasText: copy.session.otherSessionEn });
    await expect(notice).toBeVisible();
    expectGuestSafe(await notice.innerText(), "other-session notice", email);
    expect(secondBlocked, "requests of the second session that tried to leave the machine").toEqual([]);
    await other.close();
  });
});
