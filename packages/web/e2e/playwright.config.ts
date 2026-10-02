// Playwright for the web (docs/test-plan.md §2 and §3, level UI): `npm run test:ui`. Projects:
//
//   shell     login.spec.ts: Vite alone (a build with a placeholder pool and one without), the Cognito
//             API scripted by page.route (support/cognito-route.ts) and the BFF answered the same way
//             (support/api-route.ts). Nothing leaves the machine.
//   console   every console spec: the UI server of tests/ui-server (Vite + the real `appRouter` +
//             PublicWeb + a local S3 emulator), which verifies the tokens with the real verifier
//             against this run's JWKS.
//   the six projects of the public surfaces (landing, sign-up and sign-in, the guest's world), on the
//   same UI server with its Cognito double, `Leads` in memory and a recording SES:
//             mobile-es (390 × 844, touch, 3x), mobile-en, desktop-es (1440 × 900), desktop-en, and
//             mobile-es-reduced / desktop-en-reduced with `prefers-reduced-motion: reduce`. A spec
//             reads its language from the project's name (`-en`) and opens English pages with `?lang=en`.
//
// Sessions are signed with an ephemeral RSA key created here for the run (support/keys.ts): the
// workers inherit the private half through the environment, the UI server gets only the JWKS.
// Browsers are not downloaded: the installed Google Chrome is used (E2E_BROWSER_CHANNEL overrides).
// Traces and screenshots are off unless E2E_TRACE=1; output goes outside the repository.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Project, defineConfig, devices } from "@playwright/test";
import { BROWSER_CHANNEL, FAKE_POOL, OUTPUT_DIR, PORTS, SHELL_URL, TRACE, UI_SERVER_URL } from "./support/env";
import { JWKS_ENV, SIGNING_KEY_ENV, ensureEphemeralKey } from "./support/keys";

ensureEphemeralKey();

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_DIR = fileURLToPath(new URL("../../..", import.meta.url));
/** Entry of the local UI server; the projects that need it wait for it. */
const UI_SERVER_ENTRY = "tests/ui-server/main.ts";
const hasUiServer = existsSync(`${REPO_DIR}/${UI_SERVER_ENTRY}`);

const COGNITO_ENV = { VITE_COGNITO_USER_POOL_ID: FAKE_POOL.userPoolId, VITE_COGNITO_CLIENT_ID: FAKE_POOL.clientId };
const NO_COGNITO_ENV = { VITE_COGNITO_USER_POOL_ID: "", VITE_COGNITO_CLIENT_ID: "" };
// Servers inherit the runner's environment; the private key stays with the runner and its workers.
const WITHOUT_PRIVATE_KEY = { [SIGNING_KEY_ENV]: "" };

/** Specs of the public surfaces: they run in the six projects of docs/test-plan.md §3. */
export const PUBLIC_SPECS = /(^|\/)(landing|landing-tour|landing-layout|landing-cta|gallery|a11y|auth|welcome|guest-isolation|guest-copy)\.spec\.ts$/;
const SHELL_SPECS = /(^|\/)login\.spec\.ts$/;

function viteServer(port: number, env: Record<string, string>) {
  return {
    command: `npx vite --port ${port} --strictPort --host 127.0.0.1`,
    cwd: WEB_DIR,
    url: `http://127.0.0.1:${port}/login`,
    env: { ...env, ...WITHOUT_PRIVATE_KEY },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  };
}

const uiServer = {
  command: `npx tsx ${UI_SERVER_ENTRY}`,
  cwd: REPO_DIR,
  url: `${UI_SERVER_URL}/login`,
  env: { ...COGNITO_ENV, ...WITHOUT_PRIVATE_KEY, E2E_UI_SERVER_PORT: String(PORTS.ui), [JWKS_ENV]: process.env[JWKS_ENV] ?? "" },
  reuseExistingServer: false,
  timeout: 120_000,
};

const PHONE = { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } } as const;
const DESKTOP = { viewport: { width: 1440, height: 900 } } as const;

/** One project of the public surfaces: a viewport, a language (by name) and a motion preference. */
function publicProject(name: string, size: "mobile" | "desktop", lang: "es" | "en", reduced: boolean, touch = false): Project {
  return {
    name,
    testMatch: PUBLIC_SPECS,
    metadata: { lang, size, reduced },
    use: {
      baseURL: UI_SERVER_URL,
      ...(size === "mobile" ? PHONE : DESKTOP),
      ...(touch ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}),
      locale: lang === "en" ? "en-US" : "es-AR",
      contextOptions: { reducedMotion: reduced ? "reduce" : "no-preference" },
    },
  };
}

export default defineConfig({
  testDir: ".",
  outputDir: OUTPUT_DIR,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    channel: BROWSER_CHANNEL,
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    trace: TRACE ? "retain-on-failure" : "off",
    screenshot: TRACE ? "only-on-failure" : "off",
    video: "off",
  },
  projects: [
    { name: "shell", testMatch: SHELL_SPECS, use: { baseURL: SHELL_URL } },
    { name: "console", testIgnore: [SHELL_SPECS, PUBLIC_SPECS], use: { baseURL: UI_SERVER_URL } },
    publicProject("mobile-es", "mobile", "es", false, true),
    publicProject("mobile-en", "mobile", "en", false),
    publicProject("desktop-es", "desktop", "es", false),
    publicProject("desktop-en", "desktop", "en", false),
    publicProject("mobile-es-reduced", "mobile", "es", true),
    publicProject("desktop-en-reduced", "desktop", "en", true),
  ],
  webServer: [
    viteServer(PORTS.shell, COGNITO_ENV),
    viteServer(PORTS.unconfigured, NO_COGNITO_ENV),
    ...(hasUiServer ? [uiServer] : []),
  ],
});
