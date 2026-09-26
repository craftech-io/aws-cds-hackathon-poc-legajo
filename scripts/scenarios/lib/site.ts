// The public site as SC-00 reads it from outside (SMK/1-3): the landing and the legal pages with the
// security headers of the bootstrap policy, the console's login and its connection to Cognito, and the
// BFF's health probe. CloudFront may still serve the previous version right after a deploy, so every
// read retries for 30 seconds. The header and health rules are the interim smoke's (scripts/smoke).
import { DEFAULT_BASE_URL, healthVerdict, rootProblems } from "../../smoke/interim";

export const SITE = DEFAULT_BASE_URL;
const RETRY_FOR_MS = 30_000;
const RETRY_EVERY_MS = 5_000;
const TIMEOUT_MS = 10_000;

export interface Page {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export async function fetchPage(path: string, options: { readonly fetch?: typeof fetch; readonly sleep?: (ms: number) => Promise<void> } = {}): Promise<Page> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + RETRY_FOR_MS;
  for (;;) {
    try {
      const response = await doFetch(`${SITE}${path}`, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const page = { status: response.status, headers, body: await response.text() };
      if (page.status < 500 || Date.now() >= deadline) return page;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await sleep(RETRY_EVERY_MS);
  }
}

/** Problems of the landing: status and the security headers (FL-089). */
export const landingProblems = (page: Page): string[] => rootProblems(page.status, page.headers);

/** The console reaches Cognito's API from the browser: the CSP must allow it. */
export function cognitoAllowed(page: Page): boolean {
  const csp = page.headers["content-security-policy"] ?? "";
  return /connect-src[^;]*cognito-idp\.us-east-1\.amazonaws\.com/.test(csp);
}

export const healthOf = (page: Page) => healthVerdict(page.status, page.headers["content-type"] ?? "", page.body);
