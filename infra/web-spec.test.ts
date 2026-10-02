import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { API_PREFIX } from "../packages/bff/src/routers/handler";
import { CONSOLE_CSP } from "./ci-spec";
import {
  API_PATH,
  EDGE_BUDGETS,
  FIRST_DEPLOY_CHECKS,
  LAMBDA_ROUTES,
  LEGAL_PAGES,
  ORIGIN_REQUEST_POLICY,
  ORIGIN_VERIFIED_PREFIXES,
  ORIGIN_VERIFY_HEADER,
  PUBLIC_WEB_PATH,
  ROUTER_PROTECTION,
  ROUTER_READ_TIMEOUT_MAX_SECONDS,
  SST_OAC_VERIFIED,
  STATIC_FILE_OPTIONS,
  lambdaRouteFor,
  legalUrl,
  originVerifyInjection,
  routeMatches,
  type EdgeFunction,
} from "./web-spec";

const EDGE_FUNCTIONS = Object.keys(LAMBDA_ROUTES) as EdgeFunction[];
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const web = read("infra/web.ts");
const dns = read("infra/dns.ts");
const adr = read("docs/adr/0015-alta-publica-de-invitados-y-leads.md");

/** Mirrors SST's upload: entries are applied in reverse and a file keeps the first one that matches. */
function optionFor(file: string) {
  const toRegex = (glob: string) =>
    new RegExp(
      `^${glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "\u0000")
        .replace(/\*\*/g, "\u0001")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, "(?:.*/)?")
        .replace(/\u0001/g, ".*")}$`,
    );
  return [...STATIC_FILE_OPTIONS].reverse().find((option) => toRegex(option.files).test(file));
}

describe("domain", () => {
  it("serves the app on legajo.demo.craftech.io inside the delegated demos zone", () => {
    expect(dns).toContain('export const ZONE_ID = "Z043097217S4W7QWXU5O0";');
    expect(dns).toContain('export const PRODUCT_SUBDOMAIN = "legajo";');
    expect(dns).toContain("sst.aws.dns({ zone: ZONE_ID })");
    expect(web).toMatch(/domain: \{\n\s+name: appDomain,\n\s+dns,\n\s+\}/);
  });
});

describe("router layout", () => {
  it("uses the prefix the BFF handler strips", () => {
    expect(API_PATH).toBe(API_PREFIX);
  });

  it("reserves /api and /u for their functions and sends everything else to the console", () => {
    expect(lambdaRouteFor("/api/operations.list")).toBe("bff");
    expect(lambdaRouteFor("/api")).toBe("bff");
    expect(lambdaRouteFor("/u/abc123")).toBe("publicWeb");
    expect(lambdaRouteFor("/u/abc123/presign")).toBe("publicWeb");
    for (const uri of ["/", "/app/operations", "/upload", "/users", "/apix", "/legal/privacy.html", "/login"]) {
      expect(lambdaRouteFor(uri)).toBeUndefined();
    }
  });

  it("matches on segment boundaries like the Router's CloudFront function", () => {
    expect(routeMatches(PUBLIC_WEB_PATH, "/u")).toBe(true);
    expect(routeMatches(PUBLIC_WEB_PATH, "/u/token")).toBe(true);
    expect(routeMatches(PUBLIC_WEB_PATH, "/upload-guide")).toBe(false);
    expect(routeMatches("/", "/anything")).toBe(true);
  });

  it("keeps the prefixes disjoint so no route shadows another", () => {
    const prefixes = Object.values(LAMBDA_ROUTES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const a of prefixes) for (const b of prefixes) if (a !== b) expect(routeMatches(a, b)).toBe(false);
    for (const prefix of prefixes) expect(prefix).toMatch(/^\/[a-z]+$/);
  });

  it("serves the legal pages from the console bucket, never from a Lambda", () => {
    expect(LEGAL_PAGES).toEqual({ privacy: "/legal/privacy.html", terms: "/legal/terms.html" });
    for (const page of Object.values(LEGAL_PAGES)) expect(lambdaRouteFor(page)).toBeUndefined();
    expect(legalUrl("legajo.demo.craftech.io", "privacy")).toBe("https://legajo.demo.craftech.io/legal/privacy.html");
  });

  it("declares no inline routes, so bff.ts can attach its functions with url.router (and OAC applies)", () => {
    expect(web).not.toMatch(/\broutes:/);
    expect(web).toContain("protection: ROUTER_PROTECTION,");
  });
});

/** Runs the injected code on a viewer request, as the Router's CloudFront function does. */
function viewerRequest(code: string, uri: string, headers: Record<string, { value: string }> = {}): Record<string, { value: string }> {
  const event = { request: { uri, headers: { ...headers } } };
  new Function("event", code)(event);
  return event.request.headers;
}

describe("origin protection (ADR-0015 §3.1)", () => {
  const SECRET = "c2VjcmV0LXRoYXQtaXMtMzItYnl0ZXMtbG9uZy0xMjM0NQ==";

  it("puts both Function URLs, Bff and PublicWeb, behind OAC: AWS_IAM, only CloudFront with the distribution as SourceArn", () => {
    expect(ROUTER_PROTECTION).toBe("oac");
    expect(Object.keys(LAMBDA_ROUTES).sort()).toEqual(["bff", "publicWeb"]);
    const fn = read(SST_OAC_VERIFIED.function);
    expect(fn).toContain('(p) => p?.mode === "oac" || p?.mode === "oac-with-edge-signing"');
    expect(fn).toContain('isIam ? "AWS_IAM" : "NONE"');
    expect(fn).toMatch(/action: "lambda:InvokeFunctionUrl",\s*function: fn\.name,\s*principal: "cloudfront\.amazonaws\.com",\s*sourceArn: distributionArn,/);
    expect(fn).toMatch(/action: "lambda:InvokeFunction",\s*function: fn\.name,\s*principal: "cloudfront\.amazonaws\.com",\s*sourceArn: distributionArn,\s*invokedViaFunctionUrl: true,/);
    expect(fn).toMatch(/signingBehavior: "always",\s*signingProtocol: "sigv4",\s*originType: "lambda",/);
    expect(read(".sst/platform/version").trim()).toBe("4.17.1");
    expect(SST_OAC_VERIFIED.facts).toHaveLength(4);
  });

  it("forwards X-Legajo-Auth, x-amz-content-sha256 and CloudFront-Viewer-Address to the Lambda routes, and the deploy checks it", () => {
    expect(read(SST_OAC_VERIFIED.router)).toContain(`originRequestPolicyId: "${ORIGIN_REQUEST_POLICY.id}"`);
    expect(ORIGIN_REQUEST_POLICY.name).toBe("Managed-AllViewerExceptHostHeader");
    for (const header of ["x-legajo-auth", "x-amz-content-sha256", "cloudfront-viewer-address", ORIGIN_VERIFY_HEADER]) expect(ORIGIN_REQUEST_POLICY.forwards).toContain(header);
    expect(web).toContain("args.defaultCacheBehavior = withHeadersPolicy(args.defaultCacheBehavior, consoleHeadersPolicyId);");
    expect(web).toContain('if (Reflect.get(resolved, "originRequestPolicyId") !== ORIGIN_REQUEST_POLICY.id) {');
  });

  it("sets X-Origin-Verify on /api/* and /u/*, overwriting what the viewer sent, and removes it everywhere else", () => {
    const code = originVerifyInjection(SECRET);
    expect(ORIGIN_VERIFIED_PREFIXES).toEqual([API_PATH, PUBLIC_WEB_PATH]);
    for (const uri of ["/api", "/api/trpc/signup.start", "/u", "/u/abc123/presign"]) {
      expect(viewerRequest(code, uri, { [ORIGIN_VERIFY_HEADER]: { value: "forged" } })[ORIGIN_VERIFY_HEADER], uri).toEqual({ value: SECRET });
    }
    for (const uri of ["/", "/signup", "/apix", "/upload-guide", "/legal/privacy.html"]) {
      expect(viewerRequest(code, uri, { [ORIGIN_VERIFY_HEADER]: { value: "forged" } }), uri).not.toHaveProperty(ORIGIN_VERIFY_HEADER);
    }
    expect(web).toContain("const originVerifyCode = OriginVerifyKey.value.apply(originVerifyInjection);");
    expect(web).toContain("edge: { viewerRequest: { injection: originVerifyCode, kvStore: bootstrapKvStoreArn } },");
  });

  it("keeps the Router's viewer-request function under CloudFront's 10 KB", () => {
    // Measured on 2026-10-02 with SST 4.17.1: the whole function (SST's minified router, the domain
    // block and this injection) is 9,288 of 10,240 bytes; the injection gets at most 600 of them.
    expect(Buffer.byteLength(originVerifyInjection("A".repeat(128)))).toBeLessThan(600);
    expect(read(".sst/platform/version").trim()).toBe("4.17.1");
  });

  it("fails the deploy on a malformed secret without echoing it", () => {
    for (const bad of ["short", "has spaces in it and is long enough to pass the length", `${SECRET}";alert(1);//`]) {
      let message = "";
      try {
        originVerifyInjection(bad);
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/OriginVerifyKey/);
      expect(message).not.toContain(bad);
    }
  });

  it("keeps the CSP of the console free of WAF domains: the challenge needs no SDK", () => {
    expect(CONSOLE_CSP).not.toMatch(/awswaf|captcha/i);
    expect(adr).toContain("la CSP **no** suma dominios de WAF");
  });

  it("lists the checks of the first deploy of the wave", () => {
    expect(FIRST_DEPLOY_CHECKS.join("\n")).toMatch(/interstitial[\s\S]*\/signup[\s\S]*403[\s\S]*UserLambdaValidationException/);
  });
});

describe("edge budgets", () => {
  it("keeps every route timeout inside CloudFront's limits", () => {
    for (const fn of EDGE_FUNCTIONS) {
      const { routerReadTimeoutSeconds } = EDGE_BUDGETS[fn];
      expect(routerReadTimeoutSeconds).toBeGreaterThanOrEqual(1);
      expect(routerReadTimeoutSeconds).toBeLessThanOrEqual(ROUTER_READ_TIMEOUT_MAX_SECONDS);
    }
  });

  it("ends buffered Lambdas before CloudFront stops waiting for them", () => {
    for (const fn of EDGE_FUNCTIONS) expect(EDGE_BUDGETS[fn].timeoutSeconds).toBeLessThan(EDGE_BUDGETS[fn].routerReadTimeoutSeconds);
  });

  it("stays within Lambda's memory range and reserves the concurrency of docs/architecture.md §12", () => {
    for (const fn of EDGE_FUNCTIONS) {
      expect(EDGE_BUDGETS[fn].memoryMb).toBeGreaterThanOrEqual(128);
      expect(EDGE_BUDGETS[fn].memoryMb).toBeLessThanOrEqual(10_240);
    }
    expect(EDGE_BUDGETS.bff.reservedConcurrency).toBe(10);
    expect(EDGE_BUDGETS.publicWeb.reservedConcurrency).toBe(5);
  });
});

describe("static file options", () => {
  it("caches hashed bundles forever and HTML never", () => {
    expect(optionFor("assets/index-3f9a.js")?.cacheControl).toContain("immutable");
    expect(optionFor("index.html")?.cacheControl).toContain("no-store");
    expect(optionFor("brand/logo-craftech-color.svg")?.cacheControl).toBe("max-age=3600,public");
  });

  it("serves the legal pages publicly as UTF-8 HTML with a short cache", () => {
    for (const page of Object.values(LEGAL_PAGES)) {
      const option = optionFor(page.slice(1));
      expect(option?.contentType).toBe("text/html; charset=utf-8");
      expect(option?.cacheControl).toBe("max-age=300,public");
    }
  });
});
