// Runner configuration of the console specs (docs/test-plan.md §2, level UI), read once from the
// environment of the Playwright process: test tooling on a developer machine or in CI, never a
// Lambda. Nothing here is a secret and nothing points at a real user pool.
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Local servers of a run: Vite with a placeholder pool, Vite without one, and the UI server (WP-33). */
export const PORTS = { shell: 4173, unconfigured: 4175, ui: 4180 } as const;

export const SHELL_URL = `http://127.0.0.1:${PORTS.shell}`;
export const UNCONFIGURED_URL = `http://127.0.0.1:${PORTS.unconfigured}`;
export const UI_SERVER_URL = `http://127.0.0.1:${PORTS.ui}`;

/**
 * Placeholder pool of the Vite builds under test: the ids only have to look like Cognito's. Every
 * call to its endpoint is answered by page.route (support/cognito-route.ts), so none leaves the machine.
 */
export const FAKE_POOL = { userPoolId: "us-east-1_e2eLegajo", clientId: "e2e-console-client", region: "us-east-1" } as const;

export const COGNITO_ENDPOINT = `https://cognito-idp.${FAKE_POOL.region}.amazonaws.com/`;

/** Issuer the signed tokens carry; the UI server's verifier expects the same one. */
export const TOKEN_ISSUER = `https://cognito-idp.${FAKE_POOL.region}.amazonaws.com/${FAKE_POOL.userPoolId}`;

/** Traces and screenshots stay off unless E2E_TRACE=1 (docs/test-plan.md §3). */
export const TRACE = process.env.E2E_TRACE === "1";

/** Playwright output goes outside the repository. */
export const OUTPUT_DIR = process.env.E2E_OUTPUT_DIR ?? join(tmpdir(), "legajo-e2e");

/** Installed Chrome by default (no browser download); override with E2E_BROWSER_CHANNEL. */
export const BROWSER_CHANNEL = process.env.E2E_BROWSER_CHANNEL ?? "chrome";
