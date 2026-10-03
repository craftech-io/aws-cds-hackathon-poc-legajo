// "Preparando tu mundo" and the usage limits (docs/test-plan.md §3; FL-105, FL-109 to FL-111, FL-132)
// against the local UI server, which runs the real `account.ensureWorld` / `account.world` and builds
// each world from the seed's `guest` template in process: `CREATING` → `READY` → the console; a world
// that could not be prepared (scripted), with "Probar de nuevo" and "Hablemos"; the demo full, with the
// minute-by-minute retry that creates the world once a slot frees; a world destroyed by its lifetime
// that is prepared again; and `QUOTA_EXCEEDED` with the time it resets. Every project runs it.
import { GUEST_WORLD_IDLE_HOURS, GUEST_WORLD_MAX_AGE_HOURS } from "@legajo/shared/guest-limits";
import { type Page, expect, test } from "@playwright/test";
import { findNeutralHits } from "../../../scripts/lint/neutral-words.ts";
import { copy as consoleCopy } from "../src/copy/console.ts";
import { AUTH_COPY, type AuthCopy } from "../src/views/auth/copy.ts";
import { WELCOME_TIMING } from "../src/views/auth/welcome-model.ts";
import { localTime, quotaMessage } from "../src/views/auth/quota.ts";
import { createVerifiedGuest, expireWorld, inLang, routeCognitoToServer, setDemoFull, specLang, testMailbox, testViewerIp, useViewerIp } from "../../../tests/ui-server/auth/browser-helpers.ts";
import { blockExternalRequests } from "./support/assertions";
import { UI_SERVER_URL } from "./support/env";

// Fixture password of the in-memory pool: it never leaves this machine.
const PASSWORD = "Clave-de-Prueba-2026!";
const CONSOLE = /\/app\/operations/;

let t: AuthCopy;
let lang: "es" | "en";
let blocked: string[];

test.beforeEach(async ({ page }, info) => {
  lang = specLang(info);
  t = AUTH_COPY[lang];
  blocked = await blockExternalRequests(page);
  await routeCognitoToServer(page, UI_SERVER_URL);
  await useViewerIp(page, testViewerIp(info));
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(inLang("/login", lang));
  await page.getByLabel(t.login.login).fill(email);
  await page.getByLabel(t.login.password, { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: t.login.submit }).click();
}

function quotaError(path: string, quota: { readonly kind: string; readonly resetsAtReal: string }) {
  return { error: { message: "quota", code: -32_603, data: { code: "TOO_MANY_REQUESTS", httpStatus: 429, reason: "QUOTA_EXCEEDED", path, correlationId: "e2e", quota } } };
}

test.describe("[FL-105] primer ingreso de un invitado público", () => {
  test("[FL-105] prepares the world once, says what it will hold and how long it lives, then opens the console", async ({ page, request }, info) => {
    const email = testMailbox(info, "w1");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    const ensured: string[] = [];
    page.on("request", (sent) => {
      if (sent.url().includes("account.ensureWorld")) ensured.push(sent.url());
    });
    await signIn(page, email);
    await expect(page).toHaveURL(/\/welcome/);
    await expect(page.getByRole("heading", { level: 1, name: t.welcome.title })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: t.welcome.preparing })).toBeVisible();
    for (const item of t.welcome.includes) await expect(page.getByText(item, { exact: true })).toBeVisible();
    await expect(page.getByText(t.welcome.ttl(GUEST_WORLD_IDLE_HOURS, GUEST_WORLD_MAX_AGE_HOURS))).toBeVisible();
    await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1);
    expect(findNeutralHits(await page.locator("body").innerText())).toEqual([]);
    await expect(page).toHaveURL(CONSOLE, { timeout: 20_000 });
    expect(ensured).toHaveLength(1);
    await expect(page.getByRole("complementary", { name: consoleCopy.tour.title })).toBeVisible();
  });

  test("[FL-105] says honestly when the world could not be prepared, with 'Probar de nuevo' and 'Hablemos'", async ({ page, request }, info) => {
    const email = testMailbox(info, "w7");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    const answer = (data: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify([{ result: { data } }]) });
    await page.route("**/api/account.ensureWorld**", (route) => route.fulfill(answer({ state: "CREATING" })));
    await page.route("**/api/account.world**", (route) => route.fulfill(answer({ state: "FAILED" })));
    await signIn(page, email);
    await expect(page).toHaveURL(/\/welcome/);
    await expect(page.getByRole("heading", { level: 1, name: t.welcome.failed.title })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: t.welcome.retry })).toBeVisible();
    await expect(page.getByRole("button", { name: t.welcome.signOut })).toBeVisible();
    expect(findNeutralHits(await page.locator("body").innerText())).toEqual([]);
  });
});

test.describe("[FL-110] [FL-132] la demo está completa", () => {
  test("[FL-132] the account exists, nothing is created; 'Probar de nuevo' and 'Hablemos'; the world comes once a slot frees", async ({ page, request }, info) => {
    const email = testMailbox(info, "w2");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await setDemoFull(request, UI_SERVER_URL, email, true);
    await signIn(page, email);
    await expect(page.getByRole("heading", { level: 1, name: t.welcome.capacity.title })).toBeVisible();
    await expect(page.getByText(t.welcome.capacity.lead)).toBeVisible();
    const talk = page.getByRole("link", { name: new RegExp(t.welcome.capacity.talk) });
    await expect(talk).toHaveAttribute("target", "_blank");
    await expect(talk).toHaveAttribute("rel", "noopener noreferrer");
    expect(await talk.getAttribute("href")).toContain("utm_content=welcome-capacity");
    await expect(page.getByRole("button", { name: t.welcome.signOut })).toBeVisible();

    // Still full: "Probar de nuevo" answers the same, without creating anything.
    await page.getByRole("button", { name: t.welcome.retry }).click();
    await expect(page.getByRole("heading", { level: 1, name: t.welcome.capacity.title })).toBeVisible();

    await setDemoFull(request, UI_SERVER_URL, email, false);
    await page.getByRole("button", { name: t.welcome.retry }).click();
    await expect(page).toHaveURL(CONSOLE, { timeout: 20_000 });
  });

  test("[FL-110] with the tab in sight, a full demo tries again by itself every minute", async ({ page, request }, info) => {
    const email = testMailbox(info, "w3");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await setDemoFull(request, UI_SERVER_URL, email, true);
    await page.clock.install();
    await signIn(page, email);
    await expect(page.getByRole("heading", { level: 1, name: t.welcome.capacity.title })).toBeVisible();
    await setDemoFull(request, UI_SERVER_URL, email, false);
    await page.clock.fastForward(WELCOME_TIMING.capacityRetryMs + 1_000);
    await expect(page.getByRole("heading", { level: 1, name: t.welcome.title })).toBeVisible();
    await page.clock.fastForward(WELCOME_TIMING.pollMs * 3);
    await expect(page).toHaveURL(CONSOLE, { timeout: 20_000 });
  });
});

test.describe("[FL-109] el mundo vence y se recrea al volver", () => {
  test("[FL-109] the old token is refused, /welcome says the world was deleted and prepares a new one", async ({ page, request }, info) => {
    const email = testMailbox(info, "w4");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await signIn(page, email);
    await expect(page).toHaveURL(CONSOLE, { timeout: 20_000 });
    expect(await expireWorld(request, UI_SERVER_URL, email)).toBe(true);
    await page.reload();
    await expect(page).toHaveURL(/\/welcome/);
    await expect(page.getByText(t.welcome.expired(GUEST_WORLD_IDLE_HOURS, GUEST_WORLD_MAX_AGE_HOURS))).toBeVisible();
    await expect(page).toHaveURL(CONSOLE, { timeout: 20_000 });
  });
});

test.describe("[FL-111] cuotas de uso por mundo", () => {
  test("[FL-111] a refused call of the console shows the limit and the local time it resets", async ({ page, request }, info) => {
    const email = testMailbox(info, "w5");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await signIn(page, email);
    await expect(page).toHaveURL(CONSOLE, { timeout: 20_000 });
    const quota = { kind: "CLOCK_MOVES", resetsAtReal: new Date(Date.UTC(2030, 0, 2)).toISOString() } as const;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const paths = decodeURIComponent(url.pathname.replace(/^\/api\//, "")).split(",");
      if (!paths.includes("clock.get")) return route.continue();
      const answer = await route.fetch();
      const body = (await answer.json()) as unknown;
      const items = Array.isArray(body) ? body : [body];
      await route.fulfill({ status: 207, contentType: "application/json", body: JSON.stringify(paths.map((path, index) => (path === "clock.get" ? quotaError(path, quota) : items[index]))) });
    });
    await page.reload();
    const notice = page.getByRole("alert").filter({ hasText: quotaMessage(AUTH_COPY.es, quota) });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(localTime(quota.resetsAtReal));
    await notice.getByRole("button", { name: AUTH_COPY.es.quota.dismiss }).click();
    await expect(notice).toHaveCount(0);
  });

  test("[FL-111] the hourly cap of world preparations on /welcome says when it resets", async ({ page, request }, info) => {
    const email = testMailbox(info, "w6");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    const quota = { kind: "WORLD_PREPARATIONS", resetsAtReal: new Date(Date.UTC(2030, 0, 1, 15)).toISOString() } as const;
    await page.route("**/api/account.ensureWorld**", (route) =>
      route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify([quotaError("account.ensureWorld", quota)]) }),
    );
    await signIn(page, email);
    await expect(page).toHaveURL(/\/welcome/);
    await expect(page.getByRole("alert")).toHaveText(quotaMessage(t, quota));
    await expect(page.getByRole("button", { name: t.welcome.retry })).toBeVisible();
  });
});
