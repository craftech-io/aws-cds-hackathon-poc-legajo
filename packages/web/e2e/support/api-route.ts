// Specs that run on Vite alone (login.spec.ts, wave 1) answer the BFF from the page: page.route on
// `/api/**` speaks tRPC v11's batch protocol (GET for queries with `input` in the query string, POST
// for mutations with a JSON body, one result per procedure of `a,b`). Each spec scripts what the shell
// asks (`clock.get`, `account.session`) and keeps every call to assert on it. The specs of later
// waves run against the UI server and the real `appRouter` instead (tests/ui-server, WP-33).
import type { Page } from "@playwright/test";

export interface ApiError {
  readonly code: string;
  readonly httpStatus: number;
  readonly reason?: string;
}

export type ApiAnswer = { readonly data: unknown; readonly delayMs?: number } | { readonly error: ApiError; readonly delayMs?: number };

export type ApiScript = Readonly<Record<string, ApiAnswer | ((input: unknown) => ApiAnswer)>>;

export interface ApiCall {
  readonly path: string;
  readonly method: string;
  readonly input: unknown;
  readonly authorization: string | undefined;
}

/** The world of a guest or of Estudio Delta at the start of the story: 14/10 10:30, paused, quiet. */
export const CLOCK_AT_START = {
  clockId: "GLOBAL#firm-delta",
  mode: "PAUSED",
  simNow: "2026-10-14T10:30:00-03:00",
  runningUntilReal: null,
  busy: false,
  pending: [],
} as const;

/** What the shell asks on every view, with a quiet world of Estudio Delta. */
export function shellApi(overrides: ApiScript = {}): ApiScript {
  return {
    "clock.get": { data: CLOCK_AT_START },
    "account.session": { data: { firm: { name: "Estudio Delta" }, otherSession: null } },
    "account.preferences": { data: { language: null } },
    ...overrides,
  };
}

function inputsOf(url: URL, method: string, body: string | null): Record<string, unknown> {
  const raw = method === "GET" ? url.searchParams.get("input") : body;
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function envelope(path: string, answer: ApiAnswer): unknown {
  if ("error" in answer) {
    return { error: { message: answer.error.reason ?? answer.error.code, code: -32_603, data: { ...answer.error, reason: answer.error.reason ?? null, path, correlationId: "e2e-correlation" } } };
  }
  return { result: { data: answer.data } };
}

/** Routes `/api/**` to `script`; an unscripted procedure answers NOT_FOUND, as the BFF would. */
export async function routeApi(page: Page, script: ApiScript): Promise<ApiCall[]> {
  const calls: ApiCall[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const paths = decodeURIComponent(url.pathname.replace(/^.*\/api\//, "")).split(",");
    const inputs = inputsOf(url, request.method(), request.postData());
    const answers = paths.map((path, index) => {
      const input = inputs[String(index)];
      calls.push({ path, method: request.method(), input, authorization: request.headers().authorization });
      const entry = script[path];
      const answer: ApiAnswer = typeof entry === "function" ? entry(input) : (entry ?? { error: { code: "NOT_FOUND", httpStatus: 404 } });
      return { path, answer };
    });
    const delay = Math.max(0, ...answers.map(({ answer }) => answer.delayMs ?? 0));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    // tRPC answers a batch with the error's own status when it is the only call, 207 when mixed.
    const errors = answers.flatMap(({ answer }) => ("error" in answer ? [answer.error] : []));
    const status = errors.length === 0 ? 200 : answers.length === 1 ? (errors[0]?.httpStatus ?? 500) : 207;
    await route.fulfill({
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answers.map(({ path, answer }) => envelope(path, answer))),
    });
  });
  return calls;
}
