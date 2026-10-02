// Web edge of the app: one CloudFront Router on legajo.demo.craftech.io (dns.ts) and the console,
// landing and legal pages (packages/web, React 19 + Vite + Tailwind v4) served from `/`.
//
// Route layout of the Router (docs/architecture.md §10-§11); the prefixes and budgets live in
// web-spec.ts, checked by web-spec.test.ts:
//
//   /*              StaticSite Console            (this file)
//   /legal/*.html   static legal pages            (packages/web/public/legal, copied by Vite)
//   /api/*          Function Bff, tRPC            (infra/bff.ts, WP-32)
//   /u/*            Function PublicWeb, no login  (infra/bff.ts, WP-32)
//
// The Lambda routes attach from bff.ts with each function's own `url.router` prop
// (`{ instance: router, path }`); the Router declares no inline `routes`, because a Router with
// inline routes cannot be targeted by the `router` prop of other components (nor be protected).
//
// Origin protection (ADR-0015 §3.1):
//   - `protection: "oac"`: every Function attached to the Router (Bff, PublicWeb) gets an AWS_IAM URL
//     that only `cloudfront.amazonaws.com` with this distribution as SourceArn may invoke, and the
//     Router signs each request with SigV4 (web-spec.ts SST_OAC_VERIFIED). The signature replaces the
//     viewer's `Authorization`: the console sends its id token in `X-Legajo-Auth`, and every POST
//     carries `x-amz-content-sha256` with the SHA-256 of its body (Lambda takes no unsigned body).
//   - `X-Origin-Verify`: the Router's viewer-request function sets the `OriginVerifyKey` secret on
//     `/api/*` and `/u/*` (and removes it elsewhere); both handlers compare it first, in constant time.
//     Residual risk: the value is readable in the function's code inside the account
//     (cloudfront:DescribeFunction), like the rest of the distribution's configuration.
//   - The cache behavior forwards every viewer header but Host, plus `CloudFront-Viewer-Address`
//     (web-spec.ts ORIGIN_REQUEST_POLICY); the deploy fails if SST ever puts another policy there.
//   - AWS WAF: the web ACL of infra/edge-waf.ts, created by the Router (`waf`) and associated with its
//     distribution: IP reputation, rate limits and a silent challenge on `/signup` and `signup.*`.
//
// Routing table: the Router keeps its routes in a CloudFront key-value store, whose ARN carries an
// opaque id no IAM statement can predict. The store is the one the CI bootstrap creates
// (infra/bootstrap/ci-role.yaml, RouterKeyValueStore), the only store the deploy role may write, so
// a commit cannot rewrite the routes of another Router of the account.
//
// Security headers (CSP, HSTS, no framing, nosniff, referrer): the response headers policy the
// bootstrap creates, read by name and attached to every cache behavior. The deploy role cannot
// change it, so a commit cannot loosen the CSP of the console.
//
// Verify (docs/build-plan.md WP-04 and WP-51, docs/architecture.md §15 step 6):
//   curl -sI https://legajo.demo.craftech.io                     → 200 with CSP, HSTS, X-Frame-Options DENY
//   curl -sI https://legajo.demo.craftech.io/legal/privacy.html  → 200, content-type text/html
//   aws --profile craftech-demos lambda get-function-url-config --function-name <Bff or PublicWeb name> → AuthType AWS_IAM
//   curl -s -o /dev/null -w "%{http_code}" <Function URL of Bff or PublicWeb>                        → 403
//   web-spec.ts FIRST_DEPLOY_CHECKS, registered in the PR of the wave

import { authWebEnvironment } from "./auth";
import { consoleHeadersPolicyName, routerKeyValueStoreName } from "./ci-spec";
import { appDomain, dns } from "./dns";
import { applyEdgeWaf } from "./edge-waf";
import { OriginVerifyKey } from "./secrets";
import { LEGAL_PAGES, ORIGIN_REQUEST_POLICY, ROUTER_PROTECTION, STATIC_FILE_OPTIONS, legalUrl, originVerifyInjection } from "./web-spec";

export { API_PATH, LEGAL_PAGES, PUBLIC_WEB_PATH } from "./web-spec";

/** Public URLs of the legal pages. */
export const legalUrls = {
  privacy: legalUrl(appDomain, "privacy"),
  terms: legalUrl(appDomain, "terms"),
} as const satisfies Record<keyof typeof LEGAL_PAGES, string>;

// Read by name (CloudFront's id for a store), created by the bootstrap.
const bootstrapKvStoreArn = aws.cloudfront.KeyValueStore.get("RouterBootstrapKvStore", routerKeyValueStoreName($app.name, $app.stage)).arn;

// Security headers: the policy the bootstrap creates, read by name. The console takes the password
// and the TOTP code itself, so a script it did not ship must not run and no other site may frame it.
const consoleHeadersPolicyId = aws.cloudfront.getResponseHeadersPolicyOutput({ name: consoleHeadersPolicyName($app.name, $app.stage) }).id;

// Every behavior of the Router may route to a Lambda, which needs X-Legajo-Auth, x-amz-content-sha256
// and CloudFront-Viewer-Address forwarded: the deploy fails if SST ever puts another origin request policy.
function withHeadersPolicy<T extends object>(behavior: $util.Input<T>, policyId: $util.Output<string | undefined>): $util.Output<T> {
  return $util.all([behavior, policyId]).apply(([resolved, id]) => {
    if (Reflect.get(resolved, "originRequestPolicyId") !== ORIGIN_REQUEST_POLICY.id) {
      throw new Error(`The Router's cache behaviors must use the origin request policy ${ORIGIN_REQUEST_POLICY.name} (infra/web-spec.ts ORIGIN_REQUEST_POLICY).`);
    }
    return (id ? { ...resolved, responseHeadersPolicyId: id } : resolved) as T;
  });
}

// `X-Origin-Verify` on the Lambda routes; the secret's value never reaches a log or an error message.
const originVerifyCode = OriginVerifyKey.value.apply(originVerifyInjection);

export const router = new sst.aws.Router("Router", {
  domain: {
    name: appDomain,
    dns,
  },
  // Function URLs in AWS_IAM, invocable only by this distribution, every request signed (OAC).
  protection: ROUTER_PROTECTION,
  // The web ACL of infra/edge-waf.ts, associated with the distribution.
  waf: true,
  // The injection sets X-Origin-Verify; the store replaces the one SST would create (see the header).
  edge: { viewerRequest: { injection: originVerifyCode, kvStore: bootstrapKvStoreArn } },
  transform: {
    waf: applyEdgeWaf,
    cdn: (args) => {
      args.defaultCacheBehavior = withHeadersPolicy(args.defaultCacheBehavior, consoleHeadersPolicyId);
      if (args.orderedCacheBehaviors !== undefined) {
        args.orderedCacheBehaviors = $util
          .output(args.orderedCacheBehaviors)
          .apply((behaviors) => $util.all((behaviors ?? []).map((behavior) => withHeadersPolicy(behavior, consoleHeadersPolicyId))));
      }
    },
  },
});

export const consoleSite = new sst.aws.StaticSite("Console", {
  path: "packages/web",
  build: {
    command: "npm run build",
    output: "dist",
  },
  // Single-page app: unknown paths fall back to index.html (the default errorPage), so the
  // client-side router of the console resolves them.
  indexPage: "index.html",
  // Hashed bundles immutable, HTML never cached, legal pages public for five minutes (web-spec.ts).
  assets: {
    textEncoding: "utf-8",
    fileOptions: STATIC_FILE_OPTIONS.map((option) => ({ ...option })),
  },
  router: {
    instance: router,
  },
  // Cognito pool and client (auth.ts, WP-11); read by packages/web/src/lib/env.ts.
  environment: authWebEnvironment,
});
