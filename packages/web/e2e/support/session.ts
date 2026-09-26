// One session per role (docs/test-plan.md §3): a broker and an analyst of Estudio Delta, a judge of
// its own judge firm and a broker of another firm, with the claims the pre-token trigger stamps
// (packages/bff/src/auth/principal.ts). Their id tokens are signed with the run's ephemeral key
// (keys.ts), so the same session works on Vite alone, where the console only decodes the token, and
// on the UI server, where the BFF's real verifier checks it. The console keeps its tokens in
// sessionStorage only, which Playwright's storage state does not carry: they are planted with an
// init script before the page's own scripts run. Personas are the fictitious ones of docs/seed-spec.md §4.
import type { ConsoleRole } from "@legajo/shared";
import type { Page } from "@playwright/test";
import { TOKENS_KEY } from "../../src/lib/auth/tokens.ts";
import { FAKE_POOL, TOKEN_ISSUER } from "./env";
import { signJwt } from "./keys";

export { TOKENS_KEY };

export interface Persona {
  readonly sub: string;
  readonly username: string;
  readonly email?: string;
  readonly name?: string;
  readonly role: ConsoleRole;
  readonly firmId: string;
}

export const PERSONAS = {
  broker: {
    sub: "0b7f0e2e-0000-4000-8000-000000000001",
    username: "b7f0e2e1",
    email: "diego.ferreyra@sim.legajo.demo.craftech.io",
    name: "Diego Ferreyra",
    role: "BROKER",
    firmId: "firm-delta",
  },
  analyst: {
    sub: "0b7f0e2e-0000-4000-8000-000000000002",
    username: "b7f0e2e2",
    email: "martina.sosa@sim.legajo.demo.craftech.io",
    name: "Martina Sosa",
    role: "ANALYST",
    firmId: "firm-delta",
  },
  judge: {
    sub: "0b7f0e2e-0000-4000-8000-000000000003",
    username: "judge-01",
    role: "JUDGE",
    firmId: "firm-judge-01",
  },
  otherFirm: {
    sub: "0b7f0e2e-0000-4000-8000-000000000004",
    username: "b7f0e2e4",
    email: "pablo.gimenez@sim.legajo.demo.craftech.io",
    name: "Pablo Giménez",
    role: "BROKER",
    firmId: "firm-norte",
  },
} as const satisfies Record<string, Persona>;

export type PersonaName = keyof typeof PERSONAS;

export interface TokenOptions {
  /** Seconds until the id token expires; negative = already expired. Cognito issues 15 minutes. */
  readonly expiresIn?: number;
  /** Seconds since the interactive sign-in (`auth_time`); 0 by default. */
  readonly signedInAgo?: number;
}

export function idTokenFor(name: PersonaName, options: TokenOptions = {}): string {
  const persona: Persona = PERSONAS[name];
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub: persona.sub,
    iss: TOKEN_ISSUER,
    aud: FAKE_POOL.clientId,
    token_use: "id",
    iat: now,
    auth_time: now - (options.signedInAgo ?? 0),
    exp: now + (options.expiresIn ?? 900),
    "cognito:username": persona.username,
    "cognito:groups": [persona.role],
    "custom:firmId": persona.firmId,
    "custom:role": persona.role,
    ...(persona.role === "JUDGE" ? { "custom:isJudge": "true" } : {}),
    ...(persona.email !== undefined ? { email: persona.email, email_verified: true } : {}),
    ...(persona.name !== undefined ? { name: persona.name } : {}),
  });
}

export interface PlantOptions extends TokenOptions {
  /** Planted with the token set when given (sign-out revokes it, a refresh uses it). */
  readonly refreshToken?: string;
}

/** Plants a signed-in session of `name` before any script of the page runs (src/lib/auth/tokens.ts shape). */
export async function plantSession(page: Page, name: PersonaName, options: PlantOptions = {}): Promise<string> {
  const idToken = idTokenFor(name, options);
  const tokens = {
    idToken,
    accessToken: `e2e-access-${name}`,
    expiresAt: Date.now() + (options.expiresIn ?? 900) * 1_000,
    ...(options.refreshToken !== undefined ? { refreshToken: options.refreshToken } : {}),
  };
  await page.addInitScript(
    ({ key, value }) => {
      // Only on the first load of the tab: a reload or a sign-out must see what the console left.
      if (window.sessionStorage.getItem("legajo.e2e.planted") !== null) return;
      window.sessionStorage.setItem("legajo.e2e.planted", "1");
      window.sessionStorage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: JSON.stringify(tokens) },
  );
  return idToken;
}

/** The token set the console holds right now, parsed (never logged). */
export interface StoredTokens {
  readonly idToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
}

export async function storedTokens(page: Page): Promise<StoredTokens | null> {
  const raw = await page.evaluate((key) => window.sessionStorage.getItem(key), TOKENS_KEY);
  return raw === null ? null : (JSON.parse(raw) as StoredTokens);
}

/** Keys the console left in localStorage: tokens must never be there (FL-079). */
export async function localStorageKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(window.localStorage));
}
