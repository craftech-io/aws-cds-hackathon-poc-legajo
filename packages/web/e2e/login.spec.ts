// FL-079 · the console's own sign-in and its 15-minute tokens (docs/flows-catalog.md), on Vite alone
// with the Cognito API and the BFF answered from the page (support/cognito-route.ts,
// support/api-route.ts): SRP without the password on the wire, TOTP and the first password for firm
// accounts, a judge by username with neither, the judge's other-session notice without a reset,
// silent refresh, expiry, sign-out with revocation and tokens only in sessionStorage. Also the shell
// every view opens in: navigation by role and the simulated-time bar. Nothing leaves the machine.
import { type Page, expect, test } from "@playwright/test";
import { copy } from "../src/copy/console.ts";
import { NAV_ROUTES, dossierPath } from "../src/routes.ts";
import { loginCopy } from "../src/views/login/copy.ts";
import { CLOCK_AT_START, type ApiCall, routeApi, shellApi } from "./support/api-route";
import { blockExternalRequests, expectAccessibleBasics, expectNoRawCodes, expectView } from "./support/assertions";
import { challengeAnswer, challengeOf, cognitoError, passwordVerifier, routeCognito, tokensAnswer } from "./support/cognito-route";
import { FAKE_POOL, SHELL_URL, UNCONFIGURED_URL } from "./support/env";
import { PERSONAS, type PersonaName, localStorageKeys, plantSession, storedTokens } from "./support/session";

// Fixture passwords: they only ever reach the scripted Cognito of page.route.
const PASSWORD = "Fixture-Password-1!";
const NEW_PASSWORD = "Another-Fixture-7$b";

let blocked: string[];
let api: ApiCall[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
  api = await routeApi(page, shellApi());
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

async function signInWith(page: Page, login: string, password = PASSWORD): Promise<void> {
  await page.getByLabel(loginCopy.credentials.login).fill(login);
  await page.getByLabel(loginCopy.credentials.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: loginCopy.credentials.submit }).click();
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
    await expect(page.getByRole("heading", { level: 1, name: loginCopy.credentials.title })).toBeVisible();
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
    await expect(page.getByRole("heading", { name: loginCopy.totp.title })).toBeVisible();
    await page.getByLabel(loginCopy.totp.code, { exact: true }).fill("123 456");
    await page.getByRole("button", { name: loginCopy.totp.submit }).click();
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
    // Every BFF call carries the id token, never the access token.
    await expect.poll(() => api.length).toBeGreaterThan(0);
    for (const call of api) expect(call.authorization).toBe(`Bearer ${tokens?.idToken ?? ""}`);
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
    await expect(page.getByRole("heading", { name: loginCopy.newPassword.title })).toBeVisible();
    await page.getByLabel(loginCopy.newPassword.field, { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel(loginCopy.password.confirm, { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole("button", { name: loginCopy.newPassword.submit }).click();

    await expect(page.getByRole("heading", { name: loginCopy.mfaSetup.title })).toBeVisible();
    await expect(page.getByRole("img", { name: loginCopy.mfaSetup.qrLabel })).toBeVisible();
    await expect(page.getByText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP")).toBeVisible();
    await page.getByRole("button", { name: loginCopy.mfaSetup.skip }).click();
    await expectView(page, "operations");
    expect(calls.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge", "RespondToAuthChallenge", "GetUser", "AssociateSoftwareToken"]);
    expect(JSON.parse(calls[2]?.body ?? "{}")).toMatchObject({ ChallengeName: "NEW_PASSWORD_REQUIRED", ChallengeResponses: { NEW_PASSWORD: NEW_PASSWORD } });
  });

  test("[FL-079] a judge signs in with its username: no TOTP, no password change, the guided tour open", async ({ page }) => {
    const calls = await routeCognito(page, { InitiateAuth: passwordVerifier("judge"), RespondToAuthChallenge: tokensAnswer("judge") });
    await page.goto(`${SHELL_URL}/login`);
    await signInWith(page, "judge-01");
    await expectView(page, "operations");

    expect(calls.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ AuthParameters: { USERNAME: "judge-01" } });
    await expect(page.getByText(`${copy.app.roleLabel}: ${copy.roles.JUDGE}`, { exact: false })).toBeVisible();
    await expect(page.getByRole("complementary", { name: copy.tour.title })).toBeVisible();
    await expect(page.getByRole("button", { name: copy.tour.open })).toHaveAttribute("aria-pressed", "true");

    await openAccountMenu(page);
    await expect(page.getByRole("button", { name: copy.app.signOut })).toBeVisible();
    await expect(page.getByRole("button", { name: copy.account.changePassword })).toHaveCount(0);
    await expect(page.getByRole("button", { name: copy.account.totp })).toHaveCount(0);
    await expectNoRawCodes(page);
  });

  test("[FL-079] a judge whose world another session used in the last 2 hours sees the fixed notice, without a reset", async ({ page }) => {
    const lastActiveAtReal = new Date(Date.now() - 12 * 60_000 - 5_000).toISOString();
    await routeApi(page, shellApi({ "account.session": { data: { firm: { name: "Estudio Delta" }, otherSession: { lastActiveAtReal } } } }));
    await plantSession(page, "judge");
    await page.goto(`${SHELL_URL}/app/operations`);
    const notice = page.getByRole("alert").filter({ hasText: copy.session.otherSessionEn });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(copy.session.otherSession(12));
    await expect(notice.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /reiniciar/i })).toHaveCount(0);
    // The notice neither blocks nor hides the console.
    await expectView(page, "operations");
    await expect(page.getByRole("button", { name: copy.clock.next })).toBeEnabled();
  });

  test("[FL-079] a judge's first sign-in waits for its world with a notice", async ({ page }) => {
    await routeApi(page, shellApi({ "account.session": { data: { firm: { name: "Estudio Delta" } }, delayMs: 1_500 } }));
    await plantSession(page, "judge");
    await page.goto(`${SHELL_URL}/app/operations`);
    await expect(page.getByRole("status").filter({ hasText: copy.session.preparing })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: copy.session.preparing })).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByRole("alert").filter({ hasText: copy.session.otherSessionEn })).toHaveCount(0);
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
    await expect(page.getByText(loginCopy.credentials.sessionExpired)).toBeVisible();
  });

  test("[FL-079] signing out revokes the refresh token and clears the session", async ({ page }) => {
    const calls = await routeCognito(page, { RevokeToken: { body: {} } });
    await plantSession(page, "broker", { refreshToken: "e2e-refresh-broker" });
    await page.goto(`${SHELL_URL}/app/operations`);
    await expectView(page, "operations");
    await openAccountMenu(page);
    await page.getByRole("button", { name: copy.app.signOut }).click();
    await expect(page).toHaveURL(`${SHELL_URL}/login`);
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
    const dialog = page.getByRole("dialog", { name: loginCopy.changePassword.title });
    await dialog.getByLabel(loginCopy.changePassword.current, { exact: true }).fill(PASSWORD);
    await dialog.getByLabel(loginCopy.changePassword.field, { exact: true }).fill(NEW_PASSWORD);
    await dialog.getByLabel(loginCopy.password.confirm, { exact: true }).fill(NEW_PASSWORD);
    await dialog.getByRole("button", { name: loginCopy.changePassword.submit }).click();
    await expect(dialog.getByText(loginCopy.changePassword.done)).toBeVisible();
    expect(calls.map((call) => call.operation)).toEqual(["ChangePassword"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ AccessToken: "e2e-access-broker" });
  });

  test("[FL-079] a rejected sign-in shows one generic message", async ({ page }) => {
    await routeCognito(page, { InitiateAuth: passwordVerifier("broker"), RespondToAuthChallenge: cognitoError("NotAuthorizedException", "Incorrect username or password.") });
    await page.goto(`${SHELL_URL}/login`);
    await signInWith(page, "someone@sim.legajo.demo.craftech.io");
    await expect(page.getByRole("alert")).toHaveText(loginCopy.errors.INVALID_CREDENTIALS);
    await expect(page.getByText(/Incorrect username/)).toHaveCount(0);
  });

  test("[FL-079] a build without Cognito variables says so instead of offering a sign-in", async ({ page }) => {
    await page.goto(`${UNCONFIGURED_URL}/login`);
    await expect(page.getByRole("heading", { name: copy.login.unconfiguredTitle })).toBeVisible();
    await expect(page.getByText("VITE_COGNITO_USER_POOL_ID")).toBeVisible();
  });
});

test.describe("the shell after signing in", () => {
  for (const persona of ["broker", "analyst", "judge"] as const satisfies readonly PersonaName[]) {
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
    await plantSession(page, "judge");
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
