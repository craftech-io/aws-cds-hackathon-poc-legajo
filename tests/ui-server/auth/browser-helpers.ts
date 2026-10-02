// What auth.spec.ts and welcome.spec.ts share (packages/web/e2e): the real Cognito endpoint routed to
// this server's user pool, a viewer IP of their own (so specs running side by side never share the
// sign-up's IP limits), unique test mailboxes of the `qa-signup-*` fence, and the test-only routes that
// read the code an email carried or flip a guest world's switches. Only test tooling: it talks to the
// local server on 127.0.0.1, never to a real pool or mailbox.
import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import { COGNITO_ROUTE, TEST_PREFIX } from "./routes";

export const COGNITO_ENDPOINT = "https://cognito-idp.us-east-1.amazonaws.com/";

/** The language of a Playwright project (`mobile-en`, `desktop-en-reduced`): English when it says so. */
export function specLang(info: TestInfo): "es" | "en" {
  return /(^|-)en(-|$)/.test(info.project.name) ? "en" : "es";
}

/** `path` in the project's language (`?lang=en` for English; Spanish needs none). */
export function inLang(path: string, lang: "es" | "en"): string {
  if (lang === "es") return path;
  return `${path}${path.includes("?") ? "&" : "?"}lang=en`;
}

let sequence = 0;

/** A mailbox of the QA fence that the sign-up accepts (packages/bff/src/signup/bot-checks.ts). */
export function testMailbox(info: TestInfo, key: string): string {
  sequence += 1;
  const project = info.project.name.replace(/[^a-z0-9]/g, "");
  return `qa-signup-ui${project}${info.workerIndex}${sequence}-${key}@sim.legajo.demo.craftech.io`;
}

/**
 * A viewer IP of this test alone, in the private 10/8: the worker process (its index is never reused in
 * a run, even after a restart) and a counter of that process, so no two tests share the IP limits.
 */
export function testViewerIp(info: TestInfo): string {
  sequence += 1;
  return `10.${(info.workerIndex % 250) + 1}.${Math.floor(sequence / 250) % 250}.${(sequence % 250) + 1}`;
}

/** Every request of the page as coming from `ip` behind CloudFront. */
export async function useViewerIp(page: Page, ip: string): Promise<void> {
  await page.setExtraHTTPHeaders({ "x-e2e-viewer-ip": ip });
}

/** The browser's Cognito calls answered by this server's user pool. */
export async function routeCognitoToServer(page: Page, serverUrl: string): Promise<void> {
  await page.route(COGNITO_ENDPOINT, async (route) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 200, headers: cors });
      return;
    }
    const response = await route.fetch({ url: `${serverUrl}${COGNITO_ROUTE}` });
    await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
}

export interface SentCode {
  readonly kind: "SIGNUP" | "RESEND" | "FORGOT" | "EXISTING";
  readonly code: string;
  readonly subject: string;
}

/** The last email the pool sent to `to`, waiting for the dispatch that sends it; `undefined` if none came. */
export async function lastEmail(request: APIRequestContext, serverUrl: string, to: string, attempts = 20): Promise<SentCode | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const answer = await request.get(`${serverUrl}${TEST_PREFIX}email?to=${encodeURIComponent(to)}`);
    if (answer.ok()) return (await answer.json()) as SentCode;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return undefined;
}

/** Forgets the demo-wide sign-up and account-email counters (the domain of every test mailbox is one). */
export async function forgetSharedLimits(request: APIRequestContext, serverUrl: string, email: string): Promise<void> {
  await request.post(`${serverUrl}${TEST_PREFIX}shared-limits/forget`, { data: { email } });
}

/** The pending sign-up of `email` as if `seconds` had gone by on the server too. */
export async function ageSignup(request: APIRequestContext, serverUrl: string, email: string, seconds: number): Promise<void> {
  await request.post(`${serverUrl}${TEST_PREFIX}signup-age`, { data: { email, seconds } });
}

/** A public guest that already verified its email, without a world. */
export async function createVerifiedGuest(request: APIRequestContext, serverUrl: string, email: string, password: string): Promise<void> {
  const answer = await request.post(`${serverUrl}${TEST_PREFIX}users`, { data: { email, password } });
  if (!answer.ok()) throw new Error(`could not create the test guest (${answer.status()})`);
}

/** The demo full (or free again) for this account only. */
export async function setDemoFull(request: APIRequestContext, serverUrl: string, email: string, full: boolean): Promise<void> {
  await request.post(`${serverUrl}${TEST_PREFIX}guest-worlds`, { data: { email, full } });
}

/** The account's world destroyed by its lifetime, as the hourly sweep would. */
export async function expireWorld(request: APIRequestContext, serverUrl: string, email: string): Promise<boolean> {
  const answer = await request.post(`${serverUrl}${TEST_PREFIX}guest-worlds/expire`, { data: { email } });
  return ((await answer.json()) as { expired: boolean }).expired;
}

export async function leadOf(request: APIRequestContext, serverUrl: string, email: string): Promise<{ readonly contact: boolean; readonly language: string } | undefined> {
  const answer = await request.get(`${serverUrl}${TEST_PREFIX}lead?email=${encodeURIComponent(email)}`);
  return answer.ok() ? ((await answer.json()) as { contact: boolean; language: string }) : undefined;
}

/** Lead notices the fake SES took for `email` (FL-115: one per confirmed sign-up). */
export async function noticesFor(request: APIRequestContext, serverUrl: string, email: string): Promise<number> {
  return ((await (await request.get(`${serverUrl}${TEST_PREFIX}notices?email=${encodeURIComponent(email)}`)).json()) as { count: number }).count;
}

export async function invocations(request: APIRequestContext, serverUrl: string): Promise<string[]> {
  return (await (await request.get(`${serverUrl}${TEST_PREFIX}invocations`)).json()) as string[];
}

export async function revokedCount(request: APIRequestContext, serverUrl: string): Promise<number> {
  return ((await (await request.get(`${serverUrl}${TEST_PREFIX}revoked`)).json()) as { count: number }).count;
}
