// The public sign-up as a visitor goes through it, for SC-26 (docs/test-plan.md §4.5): Playwright's
// Chrome against https://legajo.demo.craftech.io (the WAF's silent challenge runs for real), the access
// screens found by their copy (packages/web/src/views/auth), and the two calls a visitor's browser could
// make on its own and the stage must refuse (Cognito's public client without a ticket, `ForgotPassword`
// past the account email quota). Mailboxes are only `qa-signup-<runId>-<key>@sim…` (never a person's);
// passwords are synthetic values of the run, never a secret. Codes and tokens never reach the report.
import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CognitoIdentityProviderClient, ForgotPasswordCommand, InitiateAuthCommand, SignUpCommand } from "@aws-sdk/client-cognito-identity-provider";
import { type Browser, type BrowserContext, type Page, expect } from "@playwright/test";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { SIM_MAIL_DOMAIN } from "@legajo/shared";
import { AUTH_COPY, type AuthCopy } from "../../../packages/web/src/views/auth/copy";
import { SITE } from "./site";

export type SignupProfile = "mobile-es" | "desktop-en";

const PROFILES: Readonly<Record<SignupProfile, Parameters<Browser["newContext"]>[0]>> = {
  "mobile-es": { viewport: { width: 390, height: 844 }, locale: "es-AR", isMobile: true, hasTouch: true },
  "desktop-en": { viewport: { width: 1440, height: 900 }, locale: "en-US" },
};

/** `signup.start` refuses, silently, a form sent sooner than 3 s after it was shown (ADR-0015 §3.1). */
export const HUMAN_PAUSE_MS = 3_200;
const REGION = "us-east-1";
/** Prefix of the stage's Lambda log groups (SST names functions `<app>-<stage>-…`). */
export const APP_LOG_GROUP_PREFIX = "/aws/lambda/aws-cds-hackathon-poc-legajo-poc-";

export const copyOf = (profile: SignupProfile): AuthCopy => AUTH_COPY[profile === "mobile-es" ? "es" : "en"];

/** The mailbox the runner types; the driver builds the very same one from its own key (signup-fence.ts). */
export function signupAddress(runId: string, key: string): string {
  return `qa-signup-${runId}-${key}@${SIM_MAIL_DOMAIN}`;
}

/** A synthetic password of the run (an account that only lives during SC-26), within the pool's policy. */
export function runPassword(runId: string, label: string): string {
  return `Sc26-${label}-${runId.slice(-12)}-Aa9!`;
}

export async function openContext(browser: Browser, profile: SignupProfile): Promise<{ readonly context: BrowserContext; readonly page: Page }> {
  const context = await browser.newContext(PROFILES[profile]);
  return { context, page: await context.newPage() };
}

/** The landing with the run's UTM, then its first "Probar la demo" (the CTA to `/signup`) with a full navigation. */
export async function signupFromLanding(page: Page, query: string): Promise<URL> {
  await page.goto(`${SITE}/${query}`);
  await page.locator('a[href^="/signup"]').first().click();
  await page.waitForURL(/\/signup(?:\?|$)/, { timeout: 60_000 });
  return new URL(page.url());
}

export interface SignupFields {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  readonly company?: string;
  readonly jobTitle?: string;
}

/** Fills the form (both consents ticked by hand: they arrive unticked), waits like a person and sends it. */
export async function submitSignup(page: Page, t: AuthCopy, fields: SignupFields): Promise<{ readonly sentAt: string; readonly durationMs: number; readonly shape: string }> {
  await expect(page.locator("#signup-terms")).not.toBeChecked();
  await expect(page.locator("#signup-contact")).not.toBeChecked();
  await page.waitForTimeout(HUMAN_PAUSE_MS);
  await page.getByLabel(t.signup.email).fill(fields.email);
  await page.getByLabel(t.signup.password, { exact: true }).fill(fields.password);
  if (fields.name !== undefined) await page.getByLabel(t.signup.name).fill(fields.name);
  if (fields.company !== undefined) await page.getByLabel(t.signup.company).fill(fields.company);
  if (fields.jobTitle !== undefined) await page.getByLabel(t.signup.jobTitle).fill(fields.jobTitle);
  await page.locator("#signup-terms").check();
  await page.locator("#signup-contact").check();
  const sentAt = new Date().toISOString();
  const answer = page.waitForResponse((response) => response.url().includes("/api/signup.start"), { timeout: 30_000 });
  await page.getByRole("button", { name: t.signup.submit }).click();
  const response = await answer;
  const timing = response.request().timing();
  await expect(page).toHaveURL(/\/signup\/verify/, { timeout: 30_000 });
  return { sentAt, durationMs: Math.round(timing.responseEnd), shape: answerShape(await response.json().catch(() => null)) };
}

/** What an answer of `signup.start` says, without its ids: the same for every branch (ADR-0015 §1.2). */
export function answerShape(body: unknown): string {
  const shape = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(shape);
    if (value === null || typeof value !== "object") return typeof value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, key === "status" ? item : shape(item)]));
  };
  return JSON.stringify(shape(body));
}

export async function enterCode(page: Page, t: AuthCopy, code: string, password: string): Promise<void> {
  await page.getByLabel(t.verify.code).fill(code);
  const again = page.getByLabel(t.verify.password, { exact: true });
  if (await again.isVisible()) await again.fill(password);
  await page.getByRole("button", { name: t.verify.submit }).click();
}

export async function signInWith(page: Page, t: AuthCopy, login: string, password: string): Promise<void> {
  await page.getByLabel(t.login.login).fill(login);
  await page.getByLabel(t.login.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: t.login.submit }).click();
}

/** The public client id, read from the console's own call to Cognito (never configured in the runner). */
export function watchClientId(page: Page): () => string | undefined {
  let clientId: string | undefined;
  page.on("request", (request) => {
    if (!request.url().includes("cognito-idp.")) return;
    try {
      const body = JSON.parse(request.postData() ?? "{}") as { ClientId?: unknown };
      if (typeof body.ClientId === "string") clientId = body.ClientId;
    } catch {
      // Not a JSON call.
    }
  });
  return () => clientId;
}

const cognito = (): CognitoIdentityProviderClient => new CognitoIdentityProviderClient({ region: REGION, maxAttempts: 2, requestHandler: new NodeHttpHandler({ requestTimeout: 15_000, connectionTimeout: 3_000 }) });

/** The error name Cognito answers, or `OK`. */
async function outcome(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "OK";
  } catch (error) {
    return error instanceof Error ? error.name : "Error";
  }
}

/** `SignUp` straight to the public client, without the signed ticket `PreSignUp` requires. */
export function directSignUp(clientId: string, email: string, password: string): Promise<string> {
  return outcome(() => cognito().send(new SignUpCommand({ ClientId: clientId, Username: email, Password: password, UserAttributes: [{ Name: "email", Value: email }] })));
}

export function directForgotPassword(clientId: string, email: string): Promise<string> {
  return outcome(() => cognito().send(new ForgotPasswordCommand({ ClientId: clientId, Username: email })));
}

/** How many log events of the app's Lambdas since `sinceMs` contain `text` (FL-121: none may). */
export async function logMentions(text: string, sinceMs: number): Promise<number> {
  const logs = new CloudWatchLogsClient({ region: REGION, maxAttempts: 3 });
  const groups: string[] = [];
  let token: string | undefined;
  do {
    const page = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: APP_LOG_GROUP_PREFIX, ...(token === undefined ? {} : { nextToken: token }) }));
    groups.push(...(page.logGroups ?? []).flatMap((group) => (group.logGroupName === undefined ? [] : [group.logGroupName])));
    token = page.nextToken;
  } while (token !== undefined);
  let count = 0;
  for (const logGroupName of groups) {
    let next: string | undefined;
    do {
      const page = await logs.send(new FilterLogEventsCommand({ logGroupName, startTime: sinceMs, filterPattern: `"${text}"`, ...(next === undefined ? {} : { nextToken: next }) }));
      count += page.events?.length ?? 0;
      next = page.nextToken;
    } while (next !== undefined);
  }
  return count;
}

/** Where the console keeps its tokens and the header it sends the id token in (packages/web/src/lib/auth/tokens.ts, lib/trpc.ts). */
const TOKENS_KEY = "legajo.console.tokens";
const AUTH_HEADER = "x-legajo-auth";

/** The id and refresh tokens of the console's session in this page (sessionStorage), never printed. */
export async function sessionTokens(page: Page): Promise<{ readonly idToken?: string; readonly refreshToken?: string }> {
  return page.evaluate((key) => {
    const raw = (globalThis as unknown as { sessionStorage: { getItem(name: string): string | null } }).sessionStorage.getItem(key);
    try {
      const parsed = JSON.parse(raw ?? "{}") as { idToken?: unknown; refreshToken?: unknown };
      return { ...(typeof parsed.idToken === "string" ? { idToken: parsed.idToken } : {}), ...(typeof parsed.refreshToken === "string" ? { refreshToken: parsed.refreshToken } : {}) };
    } catch {
      return {};
    }
  }, TOKENS_KEY);
}

/** `REFRESH_TOKEN_AUTH` with a refresh token: the error name Cognito answers, or `OK`. */
export function refreshOutcome(clientId: string, refreshToken: string): Promise<string> {
  return outcome(() => cognito().send(new InitiateAuthCommand({ ClientId: clientId, AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: refreshToken } })));
}

export interface ApiAnswer {
  readonly status: number;
  /** `data.reason` of a refusal, or the tRPC code. */
  readonly reason?: string;
}

/**
 * One POST of the console's API from inside the page (same origin, WAF cookie, the body's SHA-256 the
 * Router's OAC signs), with the given id token in the console's header, or none.
 */
export async function apiCall(page: Page, path: string, input: unknown, options: { readonly idToken?: string; readonly query?: boolean } = {}): Promise<ApiAnswer> {
  return page.evaluate(
    async ({ path: target, body, token, header, query }) => {
      const text = query ? "" : JSON.stringify(body);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      const sha = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const headers: Record<string, string> = { "content-type": "application/json", "x-amz-content-sha256": sha, ...(token === undefined ? {} : { [header]: `Bearer ${token}` }) };
      const url = query ? `/api/${target}?input=${encodeURIComponent(JSON.stringify(body))}` : `/api/${target}`;
      const response = await fetch(url, query ? { method: "GET", headers } : { method: "POST", headers, body: text });
      let reason: string | undefined;
      try {
        const parsed = (await response.json()) as { error?: { data?: { reason?: unknown; code?: unknown } } };
        const data = parsed.error?.data;
        reason = typeof data?.reason === "string" ? data.reason : typeof data?.code === "string" ? data.code : undefined;
      } catch {
        reason = undefined;
      }
      return { status: response.status, ...(reason === undefined ? {} : { reason }) };
    },
    { path, body: input, token: options.idToken, header: AUTH_HEADER, query: options.query === true },
  );
}
