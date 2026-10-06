// FL-133 · the console in Spanish and English, with the language kept per account (docs/flows-catalog.md,
// ADR-0020). Against the local UI server, which runs the real `account.preferences` and
// `account.setLanguage` over the in-memory `Runtime` table and builds each guest's world from the `guest`
// template: a visitor who signed up alone opens the console in the browser's language, picks the other
// one in the account menu, sees the whole shell change at once, keeps it after a reload and on another
// device (it comes from the account, not from the browser), and keeps it when its world is destroyed and
// built again. A language picked on the access screens is the one the console opens in, and a failed
// save does not undo the choice. Every account is its own guest, so no other spec shares its language.
// Texts are read from the copy modules: `readIn` reads them in English (the spec's own process is Spanish).
import { type Browser, type Page, type TestInfo, expect, test } from "@playwright/test";
import { createVerifiedGuest, expireWorld, inLang, routeCognitoToServer, testMailbox, testViewerIp, useViewerIp } from "../../../tests/ui-server/auth/browser-helpers.ts";
import { copy } from "../src/copy/console.ts";
import { inLang as readIn } from "../src/lib/console-lang.ts";
import { AUTH_COPY } from "../src/views/auth/copy.ts";
import { LANG_STORAGE_KEY } from "../src/views/auth/lang.ts";
import { operationsCopy } from "../src/views/operations/copy.ts";
import { blockExternalRequests } from "./support/assertions";
import { UI_SERVER_URL } from "./support/env";

// Fixture password of the in-memory pool: it never leaves this machine.
const PASSWORD = "Clave-de-Prueba-2026!";
const CONSOLE = /\/app\/operations/;

type Lang = "es" | "en";

const heading = (lang: Lang) => readIn(lang, () => copy.views.operations.title);
const accountMenu = (lang: Lang) => readIn(lang, () => copy.account.menu);

let blocked: string[];

test.beforeEach(async ({ page }, info) => {
  blocked = await blockExternalRequests(page);
  await routeCognitoToServer(page, UI_SERVER_URL);
  await useViewerIp(page, testViewerIp(info));
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

interface SignInOptions {
  /** The language the sign-in screen is shown in (the visitor's choice, else the browser's). */
  readonly screen?: Lang;
  /** `?lang=…` on the address: the visitor's own pick, which the console then opens in. */
  readonly pick?: Lang;
}

async function signIn(page: Page, email: string, options: SignInOptions = {}): Promise<void> {
  const login = AUTH_COPY[options.pick ?? options.screen ?? "es"].login;
  await page.goto(options.pick === undefined ? "/login" : inLang("/login", options.pick));
  await page.getByLabel(login.login).fill(email);
  await page.getByLabel(login.password, { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: login.submit }).click();
  await expect(page).toHaveURL(CONSOLE, { timeout: 40_000 });
}

async function expectConsoleIn(page: Page, lang: Lang): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: heading(lang) })).toBeVisible();
  await expect(page.getByRole("button", { name: accountMenu(lang) })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", lang === "en" ? "en" : "es-AR");
}

/** Opens the account menu (named in the language the console is in now) and picks `lang`. */
async function chooseLanguage(page: Page, lang: Lang): Promise<void> {
  const now: Lang = lang === "en" ? "es" : "en";
  await page.getByRole("button", { name: accountMenu(now) }).click();
  const group = page.getByRole("group", { name: readIn(now, () => copy.account.language) });
  await group.getByRole("button", { name: lang === "en" ? "English" : "Español", exact: true }).click();
}

/** Another device of the same person: its own browser context with no storage of the first one. */
async function newDevice(browser: Browser, info: TestInfo, locale: string): Promise<Page> {
  const { baseURL, timezoneId, viewport } = test.info().project.use;
  const context = await browser.newContext({ baseURL, locale, timezoneId, ...(viewport ? { viewport } : {}) });
  const page = await context.newPage();
  blocked.push(...(await blockExternalRequests(page)));
  await routeCognitoToServer(page, UI_SERVER_URL);
  await useViewerIp(page, testViewerIp(info));
  return page;
}

test.describe("[FL-133] a Spanish browser", () => {
  test.use({ locale: "es-AR" });

  test("[FL-133] opens in Spanish, switches the whole shell to English from the account menu and keeps it after a reload, on another device and across a new world", async ({ page, browser, request }, info) => {
    test.setTimeout(150_000);
    const email = testMailbox(info, "l1");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await signIn(page, email);
    await expectConsoleIn(page, "es");
    await expect(page.getByRole("navigation", { name: copy.app.navigation })).toBeVisible();

    await chooseLanguage(page, "en");
    await expectConsoleIn(page, "en");
    const english = readIn("en", () => ({ navigation: copy.app.navigation, signOut: copy.app.signOut, caption: operationsCopy.caption, tour: copy.tour.title, language: copy.account.language }));
    await expect(page.getByRole("navigation", { name: english.navigation })).toBeVisible();
    await expect(page.getByRole("table", { name: english.caption })).toBeVisible();
    await expect(page.getByRole("complementary", { name: english.tour })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: heading("es") })).toHaveCount(0);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), LANG_STORAGE_KEY)).toBe("en");
    await page.getByRole("button", { name: accountMenu("en") }).click();
    await expect(page.getByRole("button", { name: english.signOut })).toBeVisible();
    await expect(page.getByRole("group", { name: english.language }).getByRole("button", { name: "English", exact: true })).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await expectConsoleIn(page, "en");

    // Another device: no storage and a Spanish browser; the language comes from the account.
    const second = await newDevice(browser, info, "es-AR");
    await signIn(second, email);
    await expectConsoleIn(second, "en");
    await second.context().close();

    // The account's world is destroyed by its lifetime and built again: the preference was never part of it.
    expect(await expireWorld(request, UI_SERVER_URL, email)).toBe(true);
    const third = await newDevice(browser, info, "es-AR");
    await signIn(third, email);
    await expectConsoleIn(third, "en");

    // Back to Spanish: that is what the account keeps from now on.
    await chooseLanguage(third, "es");
    await expectConsoleIn(third, "es");
    const fourth = await newDevice(browser, info, "en-US");
    await signIn(fourth, email, { screen: "en" });
    await expectConsoleIn(fourth, "es");
    await third.context().close();
    await fourth.context().close();
  });

  test("[FL-133] keeps the language the person picked even when saving it with the account fails, and says so", async ({ page, request }, info) => {
    const email = testMailbox(info, "l2");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await signIn(page, email);
    await expectConsoleIn(page, "es");
    await page.route("**/api/account.setLanguage**", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify([{ error: { message: "boom", code: -32_603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, reason: null } } }]) }),
    );
    await chooseLanguage(page, "en");
    await expectConsoleIn(page, "en");
    await expect(page.getByRole("status").filter({ hasText: readIn("en", () => copy.account.languageNotSaved) })).toBeVisible();
    await page.reload();
    await expectConsoleIn(page, "en");
  });

  test("[FL-133] opens in the language the visitor picked on the access screens", async ({ page, request }, info) => {
    const email = testMailbox(info, "l3");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await signIn(page, email, { pick: "en" });
    await expectConsoleIn(page, "en");
  });
});

test.describe("[FL-133] an English browser", () => {
  test.use({ locale: "en-US" });

  test("[FL-133] opens in English on a first visit and saves nothing until the person chooses", async ({ page, request }, info) => {
    const email = testMailbox(info, "l4");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await signIn(page, email, { screen: "en" });
    await expectConsoleIn(page, "en");
    expect(await page.evaluate((key) => window.localStorage.getItem(key), LANG_STORAGE_KEY)).toBeNull();
    const saved: string[] = [];
    page.on("request", (sent) => {
      if (sent.url().includes("account.setLanguage")) saved.push(sent.url());
    });
    await page.reload();
    await expectConsoleIn(page, "en");
    expect(saved).toEqual([]);
    // It can go to Spanish, and that is what stays.
    await chooseLanguage(page, "es");
    await expectConsoleIn(page, "es");
    await page.reload();
    await expectConsoleIn(page, "es");
  });
});
