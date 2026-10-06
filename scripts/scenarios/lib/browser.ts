// The console as a guest sees it, for SC-24 and SC-25 (docs/test-plan.md §4.5): Playwright against
// https://legajo.demo.craftech.io with the synthetic account `guest-test`, whose password only CI holds
// (`GUEST_TEST_PASSWORD`, secret of scenarios.yml; never in the repository, never printed). Selectors
// are the console's own texts where they are plain data (roles and accessible names), and the form's
// field types for the sign-in form, whose copy module pulls browser-only code.
// Tokens never leave the page except to prove what they cannot do (Cognito's account API).
import { CognitoIdentityProviderClient, GetUserCommand, AssociateSoftwareTokenCommand } from "@aws-sdk/client-cognito-identity-provider";
import { type Browser, type Locator, type Page, chromium, expect } from "@playwright/test";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { copy } from "../../../packages/web/src/copy/console";
import { dataCopy } from "../../../packages/web/src/copy/console-data";
import type { TourStep } from "../../../packages/web/src/views/tour/steps";
import { SITE } from "./site";

export const GUEST_TEST_USER = "guest-test";

export class MissingSecret extends Error {
  override readonly name = "MissingSecret";
}

/** The synthetic guest's password: an environment secret of CI, never a literal. */
export function guestPassword(): string {
  const password = process.env.GUEST_TEST_PASSWORD;
  if (password === undefined || password === "") throw new MissingSecret("GUEST_TEST_PASSWORD is not set: SC-24 and SC-25 run only in scenarios.yml");
  return password;
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/** Real SRP sign-in through the console's own form; lands on the console. */
export async function signIn(page: Page, password: string): Promise<void> {
  await page.goto(`${SITE}/login`);
  await page.locator('input:not([type="password"]):not([type="hidden"])').first().fill(GUEST_TEST_USER);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

export const tourPanel = (page: Page): Locator => page.getByRole("complementary", { name: copy.tour.title });

export function moveButton(page: Page, step: TourStep, index: number): Locator {
  return tourPanel(page).getByRole("button", { name: step.moves[index]?.label.es ?? "", exact: true });
}

/** Touches a button the moment it is enabled, as a person would (never after waiting for the previous step's state). */
export async function tapWhenEnabled(button: Locator, timeoutSec: number): Promise<void> {
  await expect(button).toBeEnabled({ timeout: timeoutSec * 1_000 });
  await button.click();
}

/** The approval's password prompt of a recent login (ADR-0010). */
export async function confirmWithPassword(page: Page, password: string): Promise<void> {
  const confirm = page.getByRole("button", { name: dataCopy.recentLogin.confirm });
  if (!(await confirm.isVisible())) return;
  await confirm.click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="password"]').fill(password);
  await dialog.locator('button[type="submit"]').click();
}

/** The operation id of 4471 in this guest world, from the console's own link to its dossier. */
export async function operationIdOf(page: Page, operationNumber: string): Promise<string> {
  await page.goto(`${SITE}/app/operations`);
  const href = await page.getByRole("link", { name: new RegExp(`\\b${operationNumber}\\b`) }).first().getAttribute("href");
  const operationId = href?.split("/").at(-1);
  if (operationId === undefined || !operationId.startsWith("op-")) throw new Error(`the console shows no dossier link for ${operationNumber}`);
  return operationId;
}

interface StoredSession {
  readonly accessToken: string;
}

/** Where the console keeps its tokens: only sessionStorage, nothing in localStorage (FL-079). */
export async function tokenPlaces(page: Page): Promise<{ readonly session: StoredSession | undefined; readonly localStorageKeys: readonly string[] }> {
  return page.evaluate(() => {
    interface WebStorage {
      readonly length: number;
      key(index: number): string | null;
      getItem(key: string): string | null;
    }
    const web = globalThis as unknown as { readonly sessionStorage: WebStorage; readonly localStorage: WebStorage };
    let session: { accessToken: string } | undefined;
    for (let index = 0; index < web.sessionStorage.length; index += 1) {
      const raw = web.sessionStorage.getItem(web.sessionStorage.key(index) ?? "") ?? "";
      try {
        const parsed = JSON.parse(raw) as { accessToken?: unknown };
        if (typeof parsed.accessToken === "string") session = { accessToken: parsed.accessToken };
      } catch {
        // Not JSON: not the token set.
      }
    }
    const localStorageKeys = Array.from({ length: web.localStorage.length }, (_, index) => web.localStorage.key(index) ?? "");
    return { session, localStorageKeys };
  });
}

/**
 * The guest's access token has no `aws.cognito.signin.user.admin` scope: Cognito's account API refuses
 * it. Only the two harmless calls are tried (never ChangePassword or DeleteUser on the real account).
 */
export async function accountApiRefuses(accessToken: string): Promise<boolean> {
  const cognito = new CognitoIdentityProviderClient({ region: "us-east-1", maxAttempts: 2, requestHandler: new NodeHttpHandler({ requestTimeout: 10_000, connectionTimeout: 3_000 }) });
  const refused = async (call: () => Promise<unknown>): Promise<boolean> => {
    try {
      await call();
      return false;
    } catch (error) {
      return error instanceof Error && error.name === "NotAuthorizedException";
    }
  };
  return (
    (await refused(() => cognito.send(new GetUserCommand({ AccessToken: accessToken })))) &&
    (await refused(() => cognito.send(new AssociateSoftwareTokenCommand({ AccessToken: accessToken }))))
  );
}

/** The simulator's reply button of the importer's phone (the WhatsApp button title of the copy). */
export const phoneButton = (page: Page, title: string): Locator => page.getByRole("button", { name: title, exact: true });
