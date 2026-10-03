// The public sign-up and access (docs/test-plan.md §3; FL-101 to FL-108, FL-112, FL-113, FL-119,
// FL-120) against the local UI server: the real `signup.*`, `SignupDispatch` in process, the user pool
// that runs the real triggers, `Leads` in memory. Every project runs it (390 × 844 and 1440 × 900, es
// and en, reduced motion). Texts are asserted by their copy key; every screen's text goes through the
// neutral-surfaces word check. Codes are read from the server's test-only route, never from a mailbox.
import { GUEST_WORLD_IDLE_HOURS, GUEST_WORLD_MAX_AGE_HOURS, RESEND_WAIT_SECONDS, SIGNUP_RATE_LIMITS } from "@legajo/shared/guest-limits";
import { type Page, expect, test } from "@playwright/test";
import { findNeutralHits } from "../../../scripts/lint/neutral-words.ts";
import { copy as consoleCopy } from "../src/copy/console.ts";
import { AUTH_COPY, type AuthCopy } from "../src/views/auth/copy.ts";
import {
  ageSignup,
  createVerifiedGuest,
  forgetSharedLimits,
  inLang,
  invocations,
  lastEmail,
  leadOf,
  noticesFor,
  revokedCount,
  routeCognitoToServer,
  specLang,
  testMailbox,
  testViewerIp,
  useViewerIp,
} from "../../../tests/ui-server/auth/browser-helpers.ts";
import { blockExternalRequests } from "./support/assertions";
import { UI_SERVER_URL } from "./support/env";

// Fixture passwords of the in-memory pool: they never leave this machine.
const PASSWORD = "Clave-de-Prueba-2026!";
const NEW_PASSWORD = "Otra-Clave-Prueba-2026#";
/** `signup.start` refuses, silently, a form sent sooner than this after it was shown (ADR-0015 §3.1). */
const HUMAN_PAUSE_MS = 3_200;

let t: AuthCopy;
let lang: "es" | "en";
let blocked: string[];

test.beforeEach(async ({ page, request }, info) => {
  lang = specLang(info);
  t = AUTH_COPY[lang];
  blocked = await blockExternalRequests(page);
  await routeCognitoToServer(page, UI_SERVER_URL);
  await useViewerIp(page, testViewerIp(info));
  await forgetSharedLimits(request, UI_SERVER_URL, testMailbox(info, "limits"));
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

async function expectNeutral(page: Page): Promise<void> {
  expect(findNeutralHits(await page.locator("body").innerText())).toEqual([]);
}

async function expectAccessPage(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", t.lang.code);
  await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1);
  await expectNeutral(page);
}

interface SignupFields {
  readonly email: string;
  readonly password?: string;
  readonly terms?: boolean;
  readonly contact?: boolean;
  readonly name?: string;
}

async function fillSignup(page: Page, fields: SignupFields): Promise<void> {
  await page.getByLabel(t.signup.email).fill(fields.email);
  await page.getByLabel(t.signup.password, { exact: true }).fill(fields.password ?? PASSWORD);
  if (fields.name) await page.getByLabel(t.signup.name).fill(fields.name);
  if (fields.terms ?? true) await page.locator("#signup-terms").check();
  if (fields.contact) await page.locator("#signup-contact").check();
}

/** `/signup` with a human pause, then sent; lands on `/signup/verify`. */
async function signUp(page: Page, fields: SignupFields): Promise<void> {
  await page.goto(inLang("/signup", lang));
  await expectAccessPage(page, t.signup.title);
  await page.waitForTimeout(HUMAN_PAUSE_MS);
  await fillSignup(page, fields);
  await page.getByRole("button", { name: t.signup.submit }).click();
  await expect(page).toHaveURL(/\/signup\/verify/);
  await expectAccessPage(page, t.verify.title);
}

async function typeCode(page: Page, code: string): Promise<void> {
  await page.getByLabel(t.verify.code).fill(code);
}

async function signIn(page: Page, login: string, password = PASSWORD): Promise<void> {
  await page.getByLabel(t.login.login).fill(login);
  await page.getByLabel(t.login.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: t.login.submit }).click();
}

test.describe("[FL-101] alta pública con email nuevo", () => {
  // The first sign-in prepares the visitor's own world from the seed's `guest` template (the real world
  // factory, run in process by the UI server) and opens the console on it.
  test("[FL-101] [FL-105] [FL-120] sign-up → code → sign-in → /welcome prepares the world and opens the console", async ({ page, request }, info) => {
    const email = testMailbox(info, "a");
    await signUp(page, { email, name: "Ana Prueba" });
    await expect(page.getByText(t.verify.existingHintLink)).toBeVisible();
    await expect(page.getByText(email)).toHaveCount(0);

    const sent = await lastEmail(request, UI_SERVER_URL, email);
    expect(sent?.kind).toBe("SIGNUP");
    await typeCode(page, sent?.code ?? "");
    await expect(page).toHaveURL(/\/login\?welcome=1/);
    await expectAccessPage(page, t.login.title);
    await expect(page.getByText(t.login.notices.welcome)).toBeVisible();
    await expect(page.getByLabel(t.login.login)).toHaveValue(email);
    await expect.poll(() => invocations(request, UI_SERVER_URL)).toContain("LeadNotice");
    await expect.poll(() => noticesFor(request, UI_SERVER_URL, email)).toBe(1);

    await page.getByLabel(t.login.password, { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: t.login.submit }).click();
    await expect(page).toHaveURL(/\/welcome/);
    await expectAccessPage(page, t.welcome.title);
    await expect(page.getByText(t.welcome.ttl(GUEST_WORLD_IDLE_HOURS, GUEST_WORLD_MAX_AGE_HOURS))).toBeVisible();
    await expectNeutral(page);
    await expect(page).toHaveURL(/\/app\/operations/, { timeout: 20_000 });
    await expect(page.getByText("4471").first()).toBeVisible();
  });
});

test.describe("[FL-102] código incorrecto, vencido o con demasiados intentos", () => {
  test("[FL-102] the same message for every wrong code, then a closed sign-up after the fifth", async ({ page }, info) => {
    test.setTimeout(60_000);
    await signUp(page, { email: testMailbox(info, "b") });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await typeCode(page, "000000");
      if (attempt < 5) await expect(page.getByRole("alert")).toContainText(t.verify.errors.invalid);
    }
    await expect(page.getByRole("alert")).toContainText(t.verify.errors.expired);
    await expect(page.getByRole("button", { name: t.verify.restart })).toBeVisible();
  });
});

test.describe("[FL-103] reenviar el código", () => {
  test("[FL-103] the button waits out the countdown, sends a new code and the old one stops working", async ({ page, request }, info) => {
    await page.clock.install();
    const email = testMailbox(info, "c");
    await signUp(page, { email });
    const first = await lastEmail(request, UI_SERVER_URL, email);
    await expect(page.getByRole("button", { name: t.verify.resend })).toBeDisabled();
    await expect(page.getByText(t.verify.resendIn(RESEND_WAIT_SECONDS))).toBeVisible();
    await page.clock.fastForward((RESEND_WAIT_SECONDS + 1) * 1000);
    await ageSignup(request, UI_SERVER_URL, email, RESEND_WAIT_SECONDS + 1);
    await expect(page.getByRole("button", { name: t.verify.resend })).toBeEnabled();
    await page.getByRole("button", { name: t.verify.resend }).click();
    await expect(page.getByRole("status").filter({ hasText: t.verify.resent })).toBeVisible();
    await expect.poll(async () => (await lastEmail(request, UI_SERVER_URL, email))?.kind).toBe("RESEND");
    const second = await lastEmail(request, UI_SERVER_URL, email);
    expect(second?.code).not.toBe(first?.code);
  });
});

test.describe("[FL-104] alta con un email que ya tiene cuenta", () => {
  test("[FL-104] the same screen as a new email; the code confirms the password just chosen", async ({ page, request }, info) => {
    const email = testMailbox(info, "d");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await signUp(page, { email, password: NEW_PASSWORD });
    const sent = await lastEmail(request, UI_SERVER_URL, email);
    expect(sent?.kind).toBe("EXISTING");
    await typeCode(page, sent?.code ?? "");
    await expect(page).toHaveURL(/\/login\?welcome=1/);
    await signIn(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/welcome|\/app\//);
  });
});

test.describe("[FL-106] ingreso: credenciales incorrectas y email sin verificar", () => {
  test("[FL-106] a wrong password and an unknown email read the same", async ({ page }, info) => {
    const email = testMailbox(info, "e");
    await page.goto(inLang("/login", lang));
    await signIn(page, email, "Clave-Equivocada-2026!");
    await expect(page.getByRole("alert")).toHaveText(t.flowErrors.INVALID_CREDENTIALS);
    await expectNeutral(page);
  });

  test("[FL-106] an unverified email with the right password goes back to its code, with a resend", async ({ page, request }, info) => {
    const email = testMailbox(info, "f");
    await signUp(page, { email });
    await expect.poll(async () => (await lastEmail(request, UI_SERVER_URL, email))?.kind).toBe("SIGNUP");
    await page.getByRole("link", { name: t.verify.existingHintLink }).click();
    await signIn(page, email);
    await expect(page).toHaveURL(/\/signup\/verify\?notice=unconfirmed/);
    await expect(page.getByText(t.login.errors.unconfirmed)).toBeVisible();
  });
});

test.describe("[FL-107] recuperar la contraseña", () => {
  test("[FL-107] the same answer for any email; the code sets a new password that signs in", async ({ page, request }, info) => {
    const email = testMailbox(info, "g");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await page.goto(inLang("/login", lang));
    await page.getByRole("link", { name: t.login.forgot }).click();
    await expectAccessPage(page, t.forgot.title);
    await page.getByLabel(t.forgot.email).fill(email);
    await page.getByRole("button", { name: t.forgot.submit }).click();
    await expectAccessPage(page, t.reset.title);
    await expect(page.getByText(t.forgot.sent)).toBeVisible();
    const sent = await lastEmail(request, UI_SERVER_URL, email);
    expect(sent?.kind).toBe("FORGOT");
    await page.getByLabel(t.reset.code).fill(sent?.code ?? "");
    await page.getByLabel(t.reset.password, { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: t.reset.submit }).click();
    await expect(page).toHaveURL(/\/login\?reset=1/);
    await expect(page.getByText(t.login.notices.reset)).toBeVisible();
    await signIn(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/welcome|\/app\//);

    // An email without an account reads exactly the same.
    await page.goto(inLang("/forgot", lang));
    await page.getByLabel(t.forgot.email).fill(testMailbox(info, "nobody"));
    await page.getByRole("button", { name: t.forgot.submit }).click();
    await expect(page.getByText(t.forgot.sent)).toBeVisible();
  });
});

test.describe("[FL-108] cerrar sesión", () => {
  test("[FL-108] revokes the refresh token and lands on the landing's notice", async ({ page, request }, info) => {
    const email = testMailbox(info, "h");
    await createVerifiedGuest(request, UI_SERVER_URL, email, PASSWORD);
    await page.goto(inLang("/login", lang));
    await signIn(page, email);
    await expect(page).toHaveURL(/\/app\/operations/, { timeout: 20_000 });
    const before = await revokedCount(request, UI_SERVER_URL);
    await page.getByRole("button", { name: consoleCopy.account.menu }).click();
    await page.getByRole("button", { name: consoleCopy.app.signOut }).click();
    await expect(page).toHaveURL(/\/\?signedOut=1/);
    await expect(page.getByRole("status").filter({ hasText: t.login.notices.signedOut })).toBeVisible();
    await expect.poll(() => revokedCount(request, UI_SERVER_URL)).toBe(before + 1);
    expect(await page.evaluate(() => Object.keys(window.sessionStorage).filter((key) => key.includes("tokens")))).toEqual([]);
  });
});

test.describe("[FL-112] [FL-113] límites del alta y bots", () => {
  test("[FL-113] a filled honeypot or a form sent too fast gets the same screen and no email", async ({ page, request }, info) => {
    const honeypot = testMailbox(info, "i");
    await page.goto(inLang("/signup", lang));
    await page.waitForTimeout(HUMAN_PAUSE_MS);
    await fillSignup(page, { email: honeypot });
    // A bot fills what a person never sees: the field is off screen and out of the tab order.
    await page.locator("#signup-website").fill("https://spam.example", { force: true });
    await page.getByRole("button", { name: t.signup.submit }).click();
    await expect(page).toHaveURL(/\/signup\/verify/);
    expect(await lastEmail(request, UI_SERVER_URL, honeypot, 5)).toBeUndefined();

    const fast = testMailbox(info, "j");
    await page.goto(inLang("/signup", lang));
    await fillSignup(page, { email: fast });
    await page.getByRole("button", { name: t.signup.submit }).click();
    await expect(page).toHaveURL(/\/signup\/verify/);
    expect(await lastEmail(request, UI_SERVER_URL, fast, 5)).toBeUndefined();
  });

  test("[FL-113] a WAF challenge reloads /signup once, keeps every field but the password, and a second one says so", async ({ page }, info) => {
    const email = testMailbox(info, "q");
    let challenges = 0;
    await page.route("**/api/signup.start**", (route) => {
      challenges += 1;
      return route.fulfill({ status: 202, headers: { "x-amzn-waf-action": "challenge" }, body: "" });
    });
    await page.goto(inLang("/signup", lang));
    await fillSignup(page, { email, name: "Ana Prueba", contact: true });
    await page.getByRole("button", { name: t.signup.submit }).click();
    await expect(page).toHaveURL(/\/signup\?(.*&)?retry=1/);
    await expect(page.getByText(t.signup.retryNotice)).toBeVisible();
    await expect(page.getByLabel(t.signup.email)).toHaveValue(email);
    await expect(page.getByLabel(t.signup.name)).toHaveValue("Ana Prueba");
    await expect(page.locator("#signup-terms")).toBeChecked();
    await expect(page.locator("#signup-contact")).toBeChecked();
    await expect(page.getByLabel(t.signup.password, { exact: true })).toHaveValue("");
    expect(await page.evaluate(() => JSON.stringify(window.sessionStorage))).not.toContain(PASSWORD);

    await page.getByLabel(t.signup.password, { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: t.signup.submit }).click();
    await expect(page.getByRole("alert")).toContainText(t.states.challenge);
    expect(challenges).toBe(2);
  });

  test("[FL-112] too many sign-ups from one connection say so, without a word about the email", async ({ page }, info) => {
    const perHour = SIGNUP_RATE_LIMITS.startPerIp.find((limit) => limit.window === "HOUR")?.limit ?? 0;
    await useViewerIp(page, testViewerIp(info));
    for (let attempt = 0; attempt <= perHour; attempt += 1) {
      await page.goto(inLang("/signup", lang));
      await fillSignup(page, { email: testMailbox(info, `k${attempt}`) });
      await page.getByRole("button", { name: t.signup.submit }).click();
      if (attempt < perHour) await expect(page).toHaveURL(/\/signup\/verify/);
    }
    const [before = ""] = t.states.rateLimited(Number.MAX_SAFE_INTEGER).split(String(Number.MAX_SAFE_INTEGER));
    await expect(page.getByRole("alert")).toContainText(before);
    await expectNeutral(page);
  });

  test("[FL-112] new sign-ups paused (the answer doubled) offer to talk instead", async ({ page }, info) => {
    await page.route("**/api/signup.start**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { data: { status: "CAPACITY" } } }) }));
    await page.goto(inLang("/signup", lang));
    await fillSignup(page, { email: testMailbox(info, "l") });
    await page.getByRole("button", { name: t.signup.submit }).click();
    await expect(page.getByRole("alert")).toContainText(t.states.signupPaused);
    await expect(page.getByRole("link", { name: new RegExp(t.states.talk) })).toHaveAttribute("target", "_blank");
  });
});

test.describe("[FL-119] variantes de consentimiento", () => {
  test("[FL-119] (a) without the terms nothing is sent; the boxes start unticked", async ({ page }, info) => {
    let started = 0;
    page.on("request", (request) => {
      if (request.url().includes("signup.start")) started += 1;
    });
    await page.goto(inLang("/signup", lang));
    await expect(page.locator("#signup-terms")).not.toBeChecked();
    await expect(page.locator("#signup-contact")).not.toBeChecked();
    await fillSignup(page, { email: testMailbox(info, "m"), terms: false });
    await page.getByRole("button", { name: t.signup.submit }).click();
    await expect(page.getByText(t.signup.errors.consentTerms)).toBeVisible();
    await expect(page.getByText(t.signup.errors.summary(1))).toBeVisible();
    expect(started).toBe(0);
  });

  for (const contact of [false, true]) {
    test(`[FL-119] (${contact ? "c" : "b"}) the lead keeps the contact consent as ${String(contact)}`, async ({ page, request }, info) => {
      const email = testMailbox(info, contact ? "n" : "o");
      await signUp(page, { email, contact });
      const sent = await lastEmail(request, UI_SERVER_URL, email);
      await typeCode(page, sent?.code ?? "");
      await expect(page).toHaveURL(/\/login\?welcome=1/);
      await expect.poll(async () => (await leadOf(request, UI_SERVER_URL, email))?.contact).toBe(contact);
      expect((await leadOf(request, UI_SERVER_URL, email))?.language).toBe(lang);
    });
  }

  test("[FL-119] (d) texts that changed while the page was open ask for a reload", async ({ page }, info) => {
    await page.route("**/api/signup.start**", (route) =>
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "outdated", code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400, reason: "CONSENT_VERSIONS_OUTDATED" } } }) }),
    );
    await page.goto(inLang("/signup", lang));
    await fillSignup(page, { email: testMailbox(info, "p") });
    await page.getByRole("button", { name: t.signup.submit }).click();
    await expect(page.getByText(t.signup.errors.staleTexts)).toBeVisible();
    await expect(page.getByRole("button", { name: t.signup.errors.reload })).toBeVisible();
  });
});
