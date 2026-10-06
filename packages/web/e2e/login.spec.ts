// FL-079 · the console's own sign-in and its 15-minute tokens (docs/flows-catalog.md), on Vite alone
// with the Cognito API and the BFF answered from the page (support/cognito-route.ts,
// support/api-route.ts): SRP without the password on the wire, TOTP and the first password for firm
// accounts (staff, by invitation), a reserved guest by username with neither, a public guest without a
// world sent to /welcome, the guest's other-session notice without a reset, silent refresh, expiry,
// sign-out with revocation and tokens only in sessionStorage, and the id token in `X-Legajo-Auth`.
// Also the shell every view opens in: navigation by role and the simulated-time bar. The public sign-up
// itself runs against the UI server (auth.spec.ts, welcome.spec.ts). Nothing leaves the machine.
import { type Page, expect, test } from "@playwright/test";
import { copy } from "../src/copy/console.ts";
import { NAV_ROUTES, dossierPath } from "../src/routes.ts";
import { TOKENS_KEY } from "../src/lib/auth/tokens.ts";
import { AUTH_COPY } from "../src/views/auth/copy.ts";
import { CLOCK_AT_START, type ApiCall, routeApi, shellApi } from "./support/api-route";
import { blockExternalRequests, expectAccessibleBasics, expectNoRawCodes, expectView } from "./support/assertions";
import { challengeAnswer, challengeOf, cognitoError, passwordVerifier, routeCognito, tokensAnswer } from "./support/cognito-route";
import { FAKE_POOL, SHELL_URL, TOKEN_ISSUER, UNCONFIGURED_URL } from "./support/env";
import { signJwt } from "./support/keys";
import { PERSONAS, type PersonaName, localStorageKeys, plantSession, storedTokens } from "./support/session";

// Fixture passwords: they only ever reach the scripted Cognito of page.route.
const PASSWORD = "Fixture-Password-1!";
const NEW_PASSWORD = "Another-Fixture-7$b";

const t = AUTH_COPY.es;

let blocked: string[];
let api: ApiCall[];
/** The `X-Legajo-Auth` header of every BFF request (OAC replaces `Authorization`, ADR-0015 §3.1). */
let bffAuth: Array<string | undefined>;

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
  api = await routeApi(page, shellApi());
  bffAuth = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) bffAuth.push(request.headers()["x-legajo-auth"]);
  });
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

async function signInWith(page: Page, login: string, password = PASSWORD): Promise<void> {
  await page.getByLabel(t.login.login).fill(login);
  await page.getByLabel(t.login.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: t.login.submit }).click();
}

/** A public guest right after verifying its email: a token with the guest role and no firm yet. */
async function plantPublicGuest(page: Page): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const idToken = signJwt({
    sub: "0b7f0e2e-0000-4000-8000-000000000041",
    iss: TOKEN_ISSUER,
    aud: FAKE_POOL.clientId,
    token_use: "id",
    iat: now,
    auth_time: now,
    exp: now + 900,
    "cognito:username": "usr-01jtestpublicguest0000000",
    "cognito:groups": ["GUEST"],
    "custom:role": "GUEST",
    "custom:isGuest": "true",
    email: "qa-signup-shell-a@sim.legajo.demo.craftech.io",
  });
  const tokens = { idToken, accessToken: "e2e-access-public-guest", refreshToken: "e2e-refresh-public-guest", expiresAt: Date.now() + 900_000 };
  await page.addInitScript(({ key, value }) => window.sessionStorage.setItem(key, value), { key: TOKENS_KEY, value: JSON.stringify(tokens) });
}

function clockBar(page: Page) {
  return page.getByRole("region", { name: copy.clock.region });
}

async function openAccountMenu(page: Page) {
  await page.getByRole("button", { name: copy.account.menu }).click();
}

test.describe("[FL-079] login propio y tokens de 15 minutos", () => {
  test("[FL-079] a deep link without a session goes to /login with returnTo, branded Legajo listo · Powered by Craftech", async ({ page }) => {
    await page.goto(`${SHELL_URL}/app/operations`);
    await expect(page).toHaveURL(`${SHELL_URL}/login?returnTo=%2Fapp%2Foperations`);
    await expect(page.getByRole("heading", { level: 1, name: t.login.title })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1);
    await expect(page.getByText("Legajo listo", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Powered by/ }).first()).toHaveAttribute("href", "https://craftech.io");
    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });

  test("[FL-079] a broker signs in by SRP and TOTP: the password never leaves the browser and the 15-minute tokens live only in sessionStorage", async ({ page }) => {
    const calls = await routeCognito(page, {
      InitiateAuth: passwordVerifier("broker"),
      RespondToAuthChallenge: (call) => (challengeOf(call) === "PASSWORD_VERIFIER" ? challengeAnswer("SOFTWARE_TOKEN_MFA", "broker") : tokensAnswer("broker")),
    });
    await page.goto(`${SHELL_URL}/login?returnTo=%2Fapp%2Faudit`);
    await signInWith(page, "Diego.Ferreyra@sim.legajo.demo.craftech.io");
    await expect(page.getByRole("heading", { name: t.steps.totp.title })).toBeVisible();
    await page.getByLabel(t.steps.totp.code, { exact: true }).fill("123 456");
    await page.getByRole("button", { name: t.steps.totp.submit }).click();
    await expectView(page, "audit");
    await expect(page).toHaveURL(`${SHELL_URL}/app/audit`);

    expect(calls.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge", "RespondToAuthChallenge"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ AuthFlow: "USER_SRP_AUTH", ClientId: FAKE_POOL.clientId, AuthParameters: { USERNAME: PERSONAS.broker.email } });
    expect(JSON.parse(calls[2]?.body ?? "{}")).toMatchObject({ ChallengeName: "SOFTWARE_TOKEN_MFA", ChallengeResponses: { SOFTWARE_TOKEN_MFA_CODE: "123456" } });
    for (const call of calls) expect(call.body).not.toContain(PASSWORD);

    const tokens = await storedTokens(page);
    expect(tokens?.idToken).toBeDefined();
    const expiresAt = tokens?.expiresAt ?? 0;
    expect(expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(await localStorageKeys(page)).toEqual([]);
    // Every BFF call carries the id token in X-Legajo-Auth, never the access token nor Authorization.
    await expect.poll(() => api.length).toBeGreaterThan(0);
    for (const call of api) expect(call.authorization).toBeUndefined();
    expect(bffAuth.length).toBeGreaterThan(0);
    for (const header of bffAuth) expect(header).toBe(`Bearer ${tokens?.idToken ?? ""}`);
    await expect(page.getByText(`${copy.app.roleLabel}: ${copy.roles.BROKER} · ${copy.app.firmLabel}: Estudio Delta`)).toBeVisible();
  });

  test("[FL-079] an invited analyst's first sign-in: own password, then the optional TOTP with a QR drawn in the page", async ({ page }) => {
    const calls = await routeCognito(page, {
      InitiateAuth: passwordVerifier("analyst"),
      RespondToAuthChallenge: (call) => (challengeOf(call) === "PASSWORD_VERIFIER" ? challengeAnswer("NEW_PASSWORD_REQUIRED", "analyst") : tokensAnswer("analyst")),
      GetUser: { body: { Username: PERSONAS.analyst.username, UserMFASettingList: [] } },
      AssociateSoftwareToken: { body: { SecretCode: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" } },
    });
    await page.goto(`${SHELL_URL}/login`);
    await signInWith(page, PERSONAS.analyst.email, "Temp-Fixture-9#Aa");
    await expect(page.getByRole("heading", { name: t.steps.newPassword.title })).toBeVisible();
    await page.getByLabel(t.steps.newPassword.field, { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel(t.password.confirm, { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: t.steps.newPassword.submit }).click();

    await expect(page.getByRole("heading", { name: t.steps.mfaSetup.title })).toBeVisible();
    await expect(page.getByRole("img", { name: t.steps.mfaSetup.qrLabel })).toBeVisible();
    await expect(page.getByText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP")).toBeVisible();
    await page.getByRole("button", { name: t.steps.mfaSetup.skip }).click();
    await expectView(page, "operations");
    expect(calls.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge", "RespondToAuthChallenge", "GetUser", "AssociateSoftwareToken"]);
    expect(JSON.parse(calls[2]?.body ?? "{}")).toMatchObject({ ChallengeName: "NEW_PASSWORD_REQUIRED", ChallengeResponses: { NEW_PASSWORD: NEW_PASSWORD } });
  });

  test("[FL-079] a guest signs in with its username: no TOTP, no password change, the guided tour open", async ({ page }) => {
    const calls = await routeCognito(page, { InitiateAuth: passwordVerifier("guest"), RespondToAuthChallenge: tokensAnswer("guest") });
    await page.goto(`${SHELL_URL}/login`);
    await signInWith(page, "guest-01");
    await expectView(page, "operations");

    expect(calls.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ AuthParameters: { USERNAME: "guest-01" } });
    await expect(page.getByText(`${copy.app.roleLabel}: ${copy.roles.GUEST}`, { exact: false })).toBeVisible();
    await expect(page.getByRole("complementary", { name: copy.tour.title })).toBeVisible();
    await expect(page.getByRole("button", { name: copy.tour.open })).toHaveAttribute("aria-pressed", "true");

    await openAccountMenu(page);
    await expect(page.getByRole("button", { name: copy.app.signOut })).toBeVisible();
    await expect(page.getByRole("button", { name: copy.account.changePassword })).toHaveCount(0);
    await expect(page.getByRole("button", { name: copy.account.totp })).toHaveCount(0);
    await expectNoRawCodes(page);
  });

  test("[FL-105] a public guest without a world is sent to /welcome, which asks for one", async ({ page }) => {
    let asked = false;
    const calls = await routeApi(
      page,
      shellApi({
        "account.world": () => ({ data: { state: asked ? "CREATING" : "NONE" } }),
        "account.ensureWorld": () => {
          asked = true;
          return { data: { state: "CREATING" } };
        },
      }),
    );
    await plantPublicGuest(page);
    await page.goto(`${SHELL_URL}/app/operations`);
    await expect(page).toHaveURL(`${SHELL_URL}/welcome`);
    await expect(page.getByRole("heading", { level: 1, name: t.welcome.title })).toBeVisible();
    await expect.poll(() => calls.filter((call) => call.path === "account.ensureWorld").length).toBe(1);
    await expect.poll(() => calls.filter((call) => call.path === "account.world").length).toBeGreaterThan(1);
    expect(calls.filter((call) => call.path === "account.ensureWorld")).toHaveLength(1);
    expect(calls.some((call) => call.path === "clock.get")).toBe(false);
  });

  test("[FL-079] the id token is refreshed silently before it expires", async ({ page }) => {
    const calls = await routeCognito(page, { InitiateAuth: tokensAnswer("broker", null) });
    const planted = await plantSession(page, "broker", { expiresIn: 20, refreshToken: "e2e-refresh-broker" });
    await page.goto(`${SHELL_URL}/app/metrics`);
    await expectView(page, "metrics");
    expect(calls.map((call) => call.operation)).toEqual(["InitiateAuth"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: "e2e-refresh-broker" } });
    const tokens = await storedTokens(page);
    expect(tokens?.idToken).not.toBe(planted);
    expect(tokens?.refreshToken).toBe("e2e-refresh-broker");
  });

  test("[FL-079] an expired session without a refresh token goes back to the login", async ({ page }) => {
    await plantSession(page, "broker", { expiresIn: -60 });
    await page.goto(`${SHELL_URL}/app/registry`);
    await expect(page).toHaveURL(`${SHELL_URL}/login?returnTo=%2Fapp%2Fregistry`);
    expect(await storedTokens(page)).toBeNull();
  });

  test("[FL-079] a token the BFF refuses ends the session and says so", async ({ page }) => {
    await routeApi(page, shellApi({ "clock.get": { error: { code: "UNAUTHORIZED", httpStatus: 401, reason: "TOKEN_EXPIRED" } } }));
    await plantSession(page, "analyst");
    await page.goto(`${SHELL_URL}/app/escalations`);
    await expect(page).toHaveURL(`${SHELL_URL}/login?returnTo=%2Fapp%2Fescalations`);
    await expect(page.getByText(t.login.notices.sessionExpired)).toBeVisible();
  });

  test("[FL-108] signing out revokes the refresh token, clears the session and lands on the landing's notice", async ({ page }) => {
    const calls = await routeCognito(page, { RevokeToken: { body: {} } });
    await plantSession(page, "broker", { refreshToken: "e2e-refresh-broker" });
    await page.goto(`${SHELL_URL}/app/operations`);
    await expectView(page, "operations");
    await openAccountMenu(page);
    await page.getByRole("button", { name: copy.app.signOut }).click();
    await expect(page).toHaveURL(`${SHELL_URL}/?signedOut=1`);
    await expect(page.getByRole("status").filter({ hasText: t.login.notices.signedOut })).toBeVisible();
    await expect.poll(() => calls.map((call) => call.operation)).toEqual(["RevokeToken"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ ClientId: FAKE_POOL.clientId, Token: "e2e-refresh-broker" });
    expect(await storedTokens(page)).toBeNull();
  });

  test("[FL-079] a broker changes its own password from the account menu", async ({ page }) => {
    const calls = await routeCognito(page, { ChangePassword: { body: {} } });
    await plantSession(page, "broker");
    await page.goto(`${SHELL_URL}/app/operations`);
    await openAccountMenu(page);
    await page.getByRole("button", { name: copy.account.changePassword }).click();
    const dialog = page.getByRole("dialog", { name: t.prompts.changePassword.title });
    await dialog.getByLabel(t.prompts.changePassword.current, { exact: true }).fill(PASSWORD);
    await dialog.getByLabel(t.prompts.changePassword.field, { exact: true }).fill(NEW_PASSWORD);
    await dialog.getByLabel(t.password.confirm, { exact: true }).fill(NEW_PASSWORD);
    await dialog.getByRole("button", { name: t.prompts.changePassword.submit }).click();
    await expect(dialog.getByText(t.prompts.changePassword.done)).toBeVisible();
    expect(calls.map((call) => call.operation)).toEqual(["ChangePassword"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ AccessToken: "e2e-access-broker" });
  });

  test("[FL-079] a rejected sign-in shows one generic message", async ({ page }) => {
    await routeCognito(page, { InitiateAuth: passwordVerifier("broker"), RespondToAuthChallenge: cognitoError("NotAuthorizedException", "Incorrect username or password.") });
    await page.goto(`${SHELL_URL}/login`);
    await signInWith(page, "someone@sim.legajo.demo.craftech.io");
    await expect(page.getByRole("alert")).toHaveText(t.flowErrors.INVALID_CREDENTIALS);
    await expect(page.getByText(/Incorrect username/)).toHaveCount(0);
  });

  test("[FL-079] a build without Cognito variables says so instead of offering a sign-in", async ({ page }) => {
    await page.goto(`${UNCONFIGURED_URL}/login`);
    await expect(page.getByRole("heading", { name: t.login.unconfiguredTitle })).toBeVisible();
    await expect(page.getByText("VITE_COGNITO_USER_POOL_ID")).toBeVisible();
  });
});

test.describe("the shell after signing in", () => {
  for (const persona of ["broker", "analyst", "guest"] as const satisfies readonly PersonaName[]) {
    test(`every view of the console opens inside the shell for ${persona}`, async ({ page }) => {
      await plantSession(page, persona);
      await page.goto(`${SHELL_URL}/app/operations`);
      const nav = page.getByRole("navigation", { name: copy.app.navigation });
      for (const route of NAV_ROUTES) {
        await nav.getByRole("link", { name: copy.views[route.id].title, exact: true }).click();
        await expectView(page, route.id);
        await expect(nav.getByRole("link", { name: copy.views[route.id].title, exact: true })).toHaveAttribute("aria-current", "page");
      }
      await expectAccessibleBasics(page);
      await expectNoRawCodes(page);
      await page.goto(`${SHELL_URL}${dossierPath("op-4471")}`);
      await expectView(page, "dossier");
      await expect(nav.getByRole("link", { name: copy.views.operations.title, exact: true })).toHaveAttribute("aria-current", "page");
    });
  }

  test("/app goes to the operations and an unknown path is not found", async ({ page }) => {
    await plantSession(page, "otherFirm");
    await page.goto(`${SHELL_URL}/app`);
    await expect(page).toHaveURL(`${SHELL_URL}/app/operations`);
    await page.goto(`${SHELL_URL}/app/nowhere`);
    await expect(page.getByRole("heading", { name: copy.errors.notFoundTitle })).toBeVisible();
  });

  test("the simulated-time bar moves the paused clock to the next event", async ({ page }) => {
    let simNow: string = CLOCK_AT_START.simNow;
    api = await routeApi(
      page,
      shellApi({
        "clock.get": () => ({ data: { ...CLOCK_AT_START, simNow } }),
        "clock.advanceToNext": () => {
          simNow = "2026-10-15T10:00:00-03:00";
          return { data: { ...CLOCK_AT_START, simNow } };
        },
      }),
    );
    await plantSession(page, "guest");
    await page.goto(`${SHELL_URL}/app/simulator`);
    await expect(clockBar(page)).toContainText(`${copy.clock.label} · mié 14/10 10:30 · ${copy.clock.paused}`);
    await clockBar(page).getByRole("button", { name: copy.clock.next }).click();
    await expect(clockBar(page)).toContainText(`${copy.clock.label} · jue 15/10 10:00 · ${copy.clock.paused}`);
    expect(api.filter((call) => call.path === "clock.advanceToNext").map((call) => [call.method, call.input])).toEqual([["POST", {}]]);
  });

  test("while the world is busy the bar disables its controls, says what it waits for, and offers 'Avanzar igual' after 5 minutes", async ({ page }) => {
    let since = new Date(Date.now() - 20_000).toISOString();
    api = await routeApi(
      page,
      shellApi({
        "clock.get": () => ({ data: { ...CLOCK_AT_START, busy: true, pending: [{ kind: "MAIL", operationNumber: "4471", detail: null, sinceReal: since }] } }),
        "clock.advanceToNext": () => ({ data: CLOCK_AT_START }),
      }),
    );
    await plantSession(page, "broker");
    await page.goto(`${SHELL_URL}/app/clock`);
    const bar = clockBar(page);
    await expect(bar.getByRole("status")).toHaveText(`${copy.clock.pending.MAIL} · ${copy.clock.operation("4471")}`);
    for (const name of [copy.clock.next, copy.clock.plusHour, copy.clock.plusDay]) await expect(bar.getByRole("button", { name, exact: true })).toBeDisabled();
    await expect(bar.getByRole("button", { name: copy.clock.force })).toHaveCount(0);

    since = new Date(Date.now() - 6 * 60_000).toISOString();
    await expect(bar.getByRole("button", { name: copy.clock.force })).toBeVisible({ timeout: 8_000 });
    await expect(bar.getByText(copy.clock.forceWarning)).toBeVisible();
    await bar.getByRole("button", { name: copy.clock.force }).click();
    await expect.poll(() => api.filter((call) => call.path === "clock.advanceToNext").map((call) => call.input)).toEqual([{ force: true }]);
  });

  test("a move refused with WORLD_BUSY says the world got busy", async ({ page }) => {
    api = await routeApi(page, shellApi({ "clock.advance": { error: { code: "CONFLICT", httpStatus: 409, reason: "WORLD_BUSY" } } }));
    await plantSession(page, "analyst");
    await page.goto(`${SHELL_URL}/app/operations`);
    await clockBar(page).getByRole("button", { name: copy.clock.plusHour, exact: true }).click();
    await expect(clockBar(page).getByRole("alert")).toHaveText(copy.clock.busyRefused);
    expect(api.filter((call) => call.path === "clock.advance").map((call) => call.input)).toEqual([{ minutes: 60 }]);
  });
});
