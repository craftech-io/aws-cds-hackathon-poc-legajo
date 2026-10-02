import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSOLE_CSP } from "./ci-spec";
import {
  EDGE_WAF,
  EDGE_WAF_MONTHLY_COST_USD,
  IP_REPUTATION_GROUP,
  WEB_ACL_SCOPE,
  edgeWafRules,
  webAclName,
  webAclSettings,
  type ByteMatch,
  type WafRule,
  type WafStatement,
} from "./edge-waf-spec";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const adr = read("docs/adr/0015-alta-publica-de-invitados-y-leads.md");
const architecture = read("docs/architecture.md");
const RULES = edgeWafRules();
const rule = (name: string): WafRule => {
  const found = RULES.find((candidate) => candidate.name === name);
  expect(found, name).toBeDefined();
  return found as WafRule;
};

/** Every byte match inside a statement, however nested. */
function byteMatches(statement: unknown): ByteMatch["byteMatchStatement"][] {
  if (typeof statement !== "object" || statement === null) return [];
  const own = Reflect.get(statement, "byteMatchStatement") as ByteMatch["byteMatchStatement"] | undefined;
  return [...(own ? [own] : []), ...Object.values(statement).flatMap((value) => (Array.isArray(value) ? value.flatMap(byteMatches) : byteMatches(value)))];
}

interface Request {
  readonly method: string;
  /** The URI path as WAF reads it: no query string. */
  readonly path: string;
}

/** WAF's byte match over a request, with its text transformations in priority order. */
function matchesByte(match: ByteMatch["byteMatchStatement"], request: Request): boolean {
  let value = "uriPath" in match.fieldToMatch ? request.path : request.method;
  for (const transformation of [...match.textTransformations].sort((a, b) => a.priority - b.priority)) {
    if (transformation.type === "URL_DECODE") value = decodeURIComponent(value);
    if (transformation.type === "LOWERCASE") value = value.toLowerCase();
  }
  if (match.positionalConstraint === "CONTAINS") return value.includes(match.searchString);
  if (match.positionalConstraint === "EXACTLY") return value === match.searchString;
  return value.startsWith(match.searchString);
}

function matches(statement: WafStatement | { andStatement: { statements: ByteMatch[] } }, request: Request): boolean {
  if ("byteMatchStatement" in statement) return matchesByte(statement.byteMatchStatement, request);
  if ("andStatement" in statement) return statement.andStatement.statements.every((inner) => matches(inner, request));
  if ("orStatement" in statement) return statement.orStatement.statements.some((inner) => matches(inner, request));
  if ("rateBasedStatement" in statement) return matches(statement.rateBasedStatement.scopeDownStatement, request);
  return false;
}

const BATCHED = { method: "POST", path: "/api/trpc/account.usage,signup.start" };
const ENCODED = { method: "POST", path: "/api/trpc/%73ignup.start" };
const UPPER = { method: "POST", path: "/api/trpc/SIGNUP.START" };
const START = { method: "POST", path: "/api/trpc/signup.start" };
const DOCUMENT = { method: "GET", path: "/signup" };
const OTHER = { method: "POST", path: "/api/trpc/account.usage" };

describe("[FL-112] rate limits of the signup at the edge", () => {
  it("[FL-112] limits paths that contain signup. to 20 per 5 min per IP, decoded and lower-cased", () => {
    const signup = rule("SignupRate");
    expect(signup.action).toEqual({ block: {} });
    expect(signup.statement).toMatchObject({ rateBasedStatement: { limit: 20, aggregateKeyType: "IP", evaluationWindowSec: 300 } });
    for (const request of [START, BATCHED, ENCODED, UPPER]) expect(matches(signup.statement, request), request.path).toBe(true);
    expect(matches(signup.statement, OTHER)).toBe(false);
    expect(adr).toContain("| WAF, URI que contiene `signup.` (decodificada y en minúsculas) por IP | 20 pedidos por 5 min | 403 de WAF |");
  });

  it("[FL-112] limits /api/* to 1,500 per 5 min per IP", () => {
    const api = rule("ApiRate");
    expect(api.action).toEqual({ block: {} });
    expect(api.statement).toMatchObject({ rateBasedStatement: { limit: 1_500, aggregateKeyType: "IP", evaluationWindowSec: 300 } });
    expect(matches(api.statement, OTHER)).toBe(true);
    expect(matches(api.statement, { method: "GET", path: "/app/operations" })).toBe(false);
    expect(adr).toContain("| WAF, `/api/*` por IP | 1.500 pedidos por 5 min | 403 de WAF |");
  });

  it("[FL-112] keeps the numbers of ADR-0015 §3.2 in one place", () => {
    expect(EDGE_WAF).toMatchObject({ rateWindowSeconds: 300, signupRateLimit: 20, apiRateLimit: 1_500 });
  });
});

describe("[FL-113] bots stopped at the edge", () => {
  it("[FL-113] challenges, silently, the GET of the /signup document and every path that contains signup.", () => {
    const challenge = rule("SignupChallenge");
    expect(challenge.action).toEqual({ challenge: {} });
    expect(challenge.challengeConfig).toEqual({ immunityTimeProperty: { immunityTime: 3_600 } });
    for (const request of [DOCUMENT, START, BATCHED, ENCODED, UPPER]) expect(matches(challenge.statement, request), `${request.method} ${request.path}`).toBe(true);
    expect(matches(challenge.statement, { method: "POST", path: "/signup" })).toBe(false);
    expect(matches(challenge.statement, { method: "GET", path: "/login" })).toBe(false);
    expect(matches(challenge.statement, OTHER)).toBe(false);
  });

  it("[FL-113] never matches signup with STARTS_WITH, and always decodes and lower-cases a CONTAINS 'signup.'", () => {
    const all = RULES.flatMap((candidate) => byteMatches(candidate.statement));
    expect(all.length).toBeGreaterThan(3);
    for (const match of all.filter((candidate) => candidate.searchString.toLowerCase().includes("signup"))) {
      expect(match.positionalConstraint).not.toBe("STARTS_WITH");
      if (match.positionalConstraint === "CONTAINS") {
        expect(match.searchString).toBe("signup.");
        expect(match.textTransformations.map((transformation) => transformation.type)).toEqual(["URL_DECODE", "LOWERCASE"]);
      }
    }
    const contains = (name: string) => byteMatches(rule(name).statement).filter((match) => match.positionalConstraint === "CONTAINS");
    expect(contains("SignupRate")).toHaveLength(1);
    expect(contains("SignupChallenge")).toHaveLength(1);
  });

  it("[FL-113] stops known abusive IPs first, with AWS's managed reputation list", () => {
    expect(RULES.map((candidate) => [candidate.priority, candidate.name])).toEqual([
      [0, "IpReputation"],
      [1, "SignupRate"],
      [2, "ApiRate"],
      [3, "SignupChallenge"],
    ]);
    expect(rule("IpReputation")).toMatchObject({ overrideAction: { none: {} }, statement: { managedRuleGroupStatement: IP_REPUTATION_GROUP } });
    expect(IP_REPUTATION_GROUP).toEqual({ vendorName: "AWS", name: "AWSManagedRulesAmazonIpReputationList" });
  });

  it("[FL-113] uses no SDK, CAPTCHA, Bot Control, ATP or ACFP, so the CSP adds no WAF domain", () => {
    const text = JSON.stringify(webAclSettings("app", "poc"));
    expect(text).not.toMatch(/captcha|BotControl|ATP|ACFP|AccountTakeover|AccountCreation/i);
    expect(CONSOLE_CSP).not.toMatch(/awswaf|captcha|waf/i);
    const sources = ["infra", "packages/web/src"].flatMap((dir) =>
      readdirSync(resolve(process.cwd(), dir), { recursive: true, encoding: "utf8" })
        .filter((file) => /\.tsx?$/.test(file))
        .map((file) => `${dir}/${file}`),
    );
    for (const file of sources.filter((path) => !path.endsWith("edge-waf-spec.test.ts"))) expect(stripComments(read(file)), file).not.toContain("VITE_WAF_INTEGRATION_URL");
  });
});

describe("the web ACL", () => {
  it("has the fixed name of docs/architecture.md §1, scope CLOUDFRONT, allow by default and immunity 3,600 s", () => {
    const settings = webAclSettings("aws-cds-hackathon-poc-legajo", "poc");
    expect(settings.name).toBe("aws-cds-hackathon-poc-legajo-poc-edge");
    expect(webAclName("aws-cds-hackathon-poc-legajo", "poc")).toBe(settings.name);
    expect(architecture).toContain("| Web ACL de WAF (scope `CLOUDFRONT`) | `aws-cds-hackathon-poc-legajo-poc-edge` |");
    expect(settings.scope).toBe(WEB_ACL_SCOPE);
    expect(WEB_ACL_SCOPE).toBe("CLOUDFRONT");
    expect(settings.defaultAction).toEqual({ allow: {} });
    expect(settings.challengeConfig).toEqual({ immunityTimeProperty: { immunityTime: 3_600 } });
    expect(settings.rules).toEqual(RULES);
    for (const candidate of [...RULES.map((entry) => entry.visibilityConfig), settings.visibilityConfig]) expect(candidate.metricName).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it("is created by the Router (the sst.aws component) and associated with its distribution, every SST default rule replaced", () => {
    const web = stripComments(read("infra/web.ts"));
    expect(web).toContain("waf: true,");
    expect(web).toContain("waf: applyEdgeWaf,");
    const edge = stripComments(read("infra/edge-waf.ts"));
    expect(edge).toContain("const settings = webAclSettings($app.name, $app.stage);");
    for (const field of ["name", "scope", "description", "defaultAction", "rules", "challengeConfig", "visibilityConfig"]) expect(edge).toContain(`args.${field} = settings.${field};`);
    expect(edge).not.toMatch(/new aws\.wafv2|WebAclLoggingConfiguration|logging/);
    const router = read(".sst/platform/src/components/aws/router.ts");
    expect(router).toContain("webAclArn: wafArn,");
    expect(router).toContain('scope: "CLOUDFRONT",');
  });

  it("records its cost for the rate card (ADR-0015 §3.3)", () => {
    expect(EDGE_WAF_MONTHLY_COST_USD).toEqual({ min: 9.4, max: 11 });
    expect(adr).toContain("**US$ 9,4 a 11/mes**");
  });
});
