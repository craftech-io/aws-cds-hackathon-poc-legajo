// Route layout, budgets and static-asset policy of the web edge as plain data and pure functions.
// No SST or Pulumi dependency: infra/web.ts and infra/bff.ts build the resources from this file, and
// infra/web-spec.test.ts checks every value against the constraints below without an AWS account.
//
// Constraints, verified against SST 4.17.1 (platform/src/components/aws/router.ts):
//   - The Router matches routes by path prefix on segment boundaries and the longest prefix wins, so
//     `/u` never captures `/upload-guide` and `/api` never captures `/apix`.
//   - A route's `readTimeout` (CloudFront origin response timeout) must be 1..60 seconds without a
//     CloudFront quota increase.
//   - The Router forwards the full path: nothing is rewritten, each handler owns its prefix
//     (routers/handler.ts strips `/api`; public-web routes `/u/*`).

// ---- Routes ------------------------------------------------------------------------------------

/** Path prefix of the tRPC BFF (Function `Bff`); the console calls `/api/<procedure>`. */
export const API_PATH = "/api";

/** Path prefix of the importer's secure upload page, no login (Function `PublicWeb`, §11). */
export const PUBLIC_WEB_PATH = "/u";

/** Static legal pages served by the console bucket (packages/web/public/legal). */
export const LEGAL_PATH = "/legal";

export const LEGAL_PAGES = {
  privacy: `${LEGAL_PATH}/privacy.html`,
  terms: `${LEGAL_PATH}/terms.html`,
} as const;

export type LegalPage = keyof typeof LEGAL_PAGES;

/** Every Lambda route of the Router, by function. The StaticSite owns `/` and everything else. */
export const LAMBDA_ROUTES = {
  bff: API_PATH,
  publicWeb: PUBLIC_WEB_PATH,
} as const;

export type EdgeFunction = keyof typeof LAMBDA_ROUTES;

/** Absolute URL of a legal page on the app domain. */
export function legalUrl(domain: string, page: LegalPage): string {
  return `https://${domain}${LEGAL_PAGES[page]}`;
}

/** Same matching rule as the Router's CloudFront function: prefix on a segment boundary. */
export function routeMatches(prefix: string, uri: string): boolean {
  if (prefix === "/") return true;
  return uri.startsWith(prefix) && (uri.length === prefix.length || prefix.endsWith("/") || uri[prefix.length] === "/");
}

/** The Lambda route that serves a URI, longest prefix first; `undefined` → the console bucket. */
export function lambdaRouteFor(uri: string): EdgeFunction | undefined {
  const candidates = (Object.entries(LAMBDA_ROUTES) as Array<[EdgeFunction, string]>)
    .filter(([, prefix]) => routeMatches(prefix, uri))
    .sort(([, a], [, b]) => b.length - a.length);
  return candidates[0]?.[0];
}

// ---- Origin protection (ADR-0015 §3.1, docs/architecture.md §10) --------------------------------

/**
 * `oac`: the Router signs every request to a Lambda route with SigV4 (CloudFront Origin Access
 * Control for Lambda, configured per request by the Router's function); every Function attached with
 * `url.router` gets an `AWS_IAM` URL and a permission for `cloudfront.amazonaws.com` with the
 * distribution as SourceArn (SST_OAC_VERIFIED). A request straight to a Function URL is refused by
 * Lambda before the function runs. The signature replaces the viewer's `Authorization`, so the console
 * sends its id token in `X-Legajo-Auth` and every POST carries `x-amz-content-sha256`.
 */
export const ROUTER_PROTECTION = "oac";

/** Second control behind OAC: the handlers of Bff and PublicWeb compare it first, in constant time. */
export const ORIGIN_VERIFY_HEADER = "x-origin-verify";

/** Routes whose origin request carries `X-Origin-Verify`: the two Lambda routes, nothing else. */
export const ORIGIN_VERIFIED_PREFIXES: readonly string[] = Object.values(LAMBDA_ROUTES);

/** The secret's shape (32 random bytes in base64, docs/architecture.md §3); anything else fails the deploy. */
const ORIGIN_VERIFY_VALUE = /^[A-Za-z0-9+/_=-]{32,128}$/;

/**
 * Code injected at the start of the Router's viewer-request function: sets `X-Origin-Verify` on the
 * Lambda routes (a value the viewer sent is overwritten) and removes it everywhere else, so the static
 * bucket never sees it. A header set there is a viewer header for the origin request policy, which
 * forwards it. The value never appears in a message: an invalid secret fails without echoing it.
 */
export function originVerifyInjection(value: string): string {
  if (!ORIGIN_VERIFY_VALUE.test(value)) throw new Error("the OriginVerifyKey secret must be 32 to 128 base64 characters (openssl rand -base64 32)");
  const tests = ORIGIN_VERIFIED_PREFIXES.map((prefix) => `legajoOriginUri === "${prefix}" || legajoOriginUri.indexOf("${prefix}/") === 0`).join(" || ");
  return [
    "const legajoOriginUri = event.request.uri;",
    `if (${tests}) {`,
    `  event.request.headers["${ORIGIN_VERIFY_HEADER}"] = { value: ${JSON.stringify(value)} };`,
    "} else {",
    `  delete event.request.headers["${ORIGIN_VERIFY_HEADER}"];`,
    "}",
  ].join("\n");
}

/**
 * Origin request policy of the Router's cache behavior: SST's lazy Router sets CloudFront's managed
 * AllViewerExceptHostHeader. It forwards every viewer header but Host (so `X-Legajo-Auth`,
 * `x-amz-content-sha256` and the `X-Origin-Verify` the viewer-request function sets) and "all device
 * type and viewer location headers", among them `CloudFront-Viewer-Address`, the viewer's IP and port
 * (CloudFront Developer Guide, "Use managed origin request policies" and "Viewer location headers",
 * read on 2026-10-02). infra/web.ts fails the deploy if the behavior ever carries another policy.
 */
export const ORIGIN_REQUEST_POLICY = {
  id: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
  name: "Managed-AllViewerExceptHostHeader",
  forwards: ["x-legajo-auth", "x-amz-content-sha256", ORIGIN_VERIFY_HEADER, "cloudfront-viewer-address"],
} as const;

/** What was read in the pinned SST (4.17.1) to rely on `protection: "oac"` (web-spec.test.ts re-reads it). */
export const SST_OAC_VERIFIED = {
  verifiedOn: "2026-10-02",
  function: ".sst/platform/src/components/aws/function.ts",
  router: ".sst/platform/src/components/aws/router.ts",
  facts: [
    "a url.router route of a Router with protection oac gets authorizationType AWS_IAM",
    "lambda.Permission InvokeFunctionUrl and InvokeFunction for cloudfront.amazonaws.com with the distribution ARN as sourceArn",
    "the route metadata carries originAccessControlConfig signingBehavior always, sigv4, originType lambda",
    "the lazy Router's cache behavior uses the origin request policy b689b0a8-53d0-40ab-baf2-68738e2966ac",
  ],
} as const;

/**
 * Checks of the first deploy of the wave, registered in its PR (ADR-0015 §3.2 and §3.3,
 * docs/architecture.md §15 step 6). A failure stops the wave and goes to `architect`.
 */
export const FIRST_DEPLOY_CHECKS = [
  "WAF's challenge interstitial loads and resolves on /signup under the console's response headers policy; if the CSP blocks it, /signup gets its own cache behavior and policy (ADR-0015 §3.3)",
  "a curl straight to the Function URL of Bff and of PublicWeb answers 403",
  "an error of AuthCustomMessage fails the call with UserLambdaValidationException and Cognito sends no email; otherwise plan B of ADR-0015 §3.2 with an ADR",
] as const;

// ---- Budgets -----------------------------------------------------------------------------------

/** CloudFront's ceiling for the origin response timeout without a quota increase. */
export const ROUTER_READ_TIMEOUT_MAX_SECONDS = 60;

export interface EdgeFunctionBudget {
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
  /** CloudFront origin response timeout of the route. */
  readonly routerReadTimeoutSeconds: number;
  /** Reserved concurrency (docs/architecture.md §12). */
  readonly reservedConcurrency: number;
}

export const EDGE_BUDGETS: Readonly<Record<EdgeFunction, EdgeFunctionBudget>> = {
  // Console procedures read DynamoDB, enqueue work and presign URLs: a buffered response must arrive
  // before CloudFront gives up, so the Lambda ends first.
  bff: { timeoutSeconds: 28, memoryMb: 1024, routerReadTimeoutSeconds: 30, reservedConcurrency: 10 },
  // The upload page and one presigned POST per file.
  publicWeb: { timeoutSeconds: 15, memoryMb: 512, routerReadTimeoutSeconds: 20, reservedConcurrency: 5 },
};

// ---- Static assets -----------------------------------------------------------------------------

export interface StaticFileOption {
  readonly files: string;
  readonly cacheControl: string;
  readonly contentType?: string;
}

/**
 * Upload policy of the console bucket. SST applies the entries in reverse order and a file takes the
 * first entry that matches it, so the LAST matching entry wins:
 *   - `assets/**`: Vite's content-hashed bundles, immutable for a year;
 *   - any other file copied from packages/web/public (logos, landing captures): one hour;
 *   - HTML never cached, so a deploy is visible at once (index.html points at the new bundle);
 *   - the legal pages: public, five minutes, explicit UTF-8 so the Spanish text renders everywhere.
 */
export const STATIC_FILE_OPTIONS: readonly StaticFileOption[] = [
  { files: "**", cacheControl: "max-age=3600,public" },
  { files: "assets/**", cacheControl: "max-age=31536000,public,immutable" },
  { files: "**/*.html", cacheControl: "max-age=0,no-cache,no-store,must-revalidate" },
  { files: `${LEGAL_PATH.slice(1)}/*.html`, cacheControl: "max-age=300,public", contentType: "text/html; charset=utf-8" },
];
