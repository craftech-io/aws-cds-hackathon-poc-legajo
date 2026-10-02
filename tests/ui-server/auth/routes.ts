// Paths of the local UI server that exist only here (test-routes.ts), shared with the specs' helpers
// (browser-helpers.ts) without pulling the server into the Playwright runner.

/** The browser's Cognito API, where the specs route the real endpoint. */
export const COGNITO_ROUTE = "/__cognito";

/** Test-only switches and reads: the last email to an address, a lead, the guest worlds. */
export const TEST_PREFIX = "/__test/";
