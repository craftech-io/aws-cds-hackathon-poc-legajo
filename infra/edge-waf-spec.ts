// The web ACL of the edge as plain data and pure functions (ADR-0015 §3.1 and §3.3, docs/architecture.md
// §10 and §13, docs/build-plan.md WP-51). No SST or Pulumi dependency: infra/edge-waf.ts lays these
// arguments over the web ACL the Router creates (`waf` + `transform.waf` of `sst.aws.Router`, the SST
// component, which also associates it with the distribution), and infra/edge-waf-spec.test.ts checks
// every value against the ADR without an AWS account.
//
// Four rules, in this order:
//   0 IpReputation     AWS managed list of IPs known for abuse (block)
//   1 SignupRate       20 requests per 5 min per IP to any path that CONTAINS `signup.` after URL_DECODE
//                      and LOWERCASE, so a batch or an encoding cannot hide a `signup.*` (block, 403)
//   2 ApiRate          1,500 requests per 5 min per IP to `/api/` (block, 403)
//   3 SignupChallenge  silent Challenge, no SDK: a GET of exactly `/signup` (the document the browser
//                      opens with a full navigation) OR any path that contains `signup.`; immunity 3,600 s
// A match on `signup.` is never STARTS_WITH: `/api/trpc/account.usage,signup.start` starts with
// `/api/trpc/account` and would slip past. WAF's rate rules aggregate by individual address (also in
// IPv6); the /64 aggregation of the BFF is the one that counts for the signup's own limits.
//
// No SDK of WAF (its integration URL exists only with ATP, ACFP or targeted Bot Control), no CAPTCHA,
// no Bot Control: the CSP adds no WAF domain and there is no `VITE_WAF_INTEGRATION_URL`.

export const WEB_ACL_SCOPE = "CLOUDFRONT";

/** Fixed name of the web ACL (docs/architecture.md §1), inside the deploy role's `<app>-<stage>-*` fence. */
export function webAclName(app: string, stage: string): string {
  return `${app}-${stage}-edge`;
}

export const EDGE_WAF = {
  /** Evaluation window of both rate rules. */
  rateWindowSeconds: 300,
  /** Requests per window per IP to a path that contains `signup.` (ADR-0015 §3.2). */
  signupRateLimit: 20,
  /** Requests per window per IP to `/api/*` (ADR-0015 §3.2). */
  apiRateLimit: 1_500,
  /** A solved challenge lasts an hour; the form lives up to 2 h and recovers by reloading (§3.1). */
  challengeImmunitySeconds: 3_600,
  /** What every `signup.*` procedure path contains: `/api/trpc/signup.start`. */
  signupMarker: "signup.",
  /** The document of the signup, always opened with a full navigation (§3.3). */
  signupDocumentPath: "/signup",
  apiPrefix: "/api/",
} as const;

/** The AWS managed rule group of the reputation rule (no WCU-heavy Bot Control, no ATP, no ACFP). */
export const IP_REPUTATION_GROUP = { vendorName: "AWS", name: "AWSManagedRulesAmazonIpReputationList" } as const;

/** Prefix of every CloudWatch metric the web ACL publishes (`AWS/WAFV2`, free). */
export const WAF_METRIC_PREFIX = "LegajoEdge";

type TextTransformation = { priority: number; type: "URL_DECODE" | "LOWERCASE" | "NONE" };
type FieldToMatch = { uriPath: Record<string, never> } | { method: Record<string, never> };

export interface ByteMatch {
  readonly byteMatchStatement: {
    readonly searchString: string;
    readonly positionalConstraint: "CONTAINS" | "EXACTLY" | "STARTS_WITH";
    readonly fieldToMatch: FieldToMatch;
    readonly textTransformations: TextTransformation[];
  };
}

export interface RateBased {
  readonly rateBasedStatement: { readonly limit: number; readonly aggregateKeyType: "IP"; readonly evaluationWindowSec: number; readonly scopeDownStatement: ByteMatch };
}

export interface ManagedGroup {
  readonly managedRuleGroupStatement: { readonly vendorName: string; readonly name: string };
}

export interface OrOfStatements {
  readonly orStatement: { readonly statements: Array<ByteMatch | { andStatement: { statements: ByteMatch[] } }> };
}

export type WafStatement = ByteMatch | RateBased | ManagedGroup | OrOfStatements;

export interface WafRule {
  readonly name: string;
  readonly priority: number;
  readonly action?: { block: Record<string, never> } | { challenge: Record<string, never> };
  readonly overrideAction?: { none: Record<string, never> };
  readonly challengeConfig?: { immunityTimeProperty: { immunityTime: number } };
  readonly statement: WafStatement;
  readonly visibilityConfig: { cloudwatchMetricsEnabled: true; metricName: string; sampledRequestsEnabled: true };
}

const visibility = (name: string): WafRule["visibilityConfig"] => ({ cloudwatchMetricsEnabled: true, metricName: `${WAF_METRIC_PREFIX}${name}`, sampledRequestsEnabled: true });

/** A path that contains `signup.` once decoded and lower-cased. */
export const SIGNUP_PATH_MATCH: ByteMatch = {
  byteMatchStatement: {
    searchString: EDGE_WAF.signupMarker,
    positionalConstraint: "CONTAINS",
    fieldToMatch: { uriPath: {} },
    textTransformations: [
      { priority: 0, type: "URL_DECODE" },
      { priority: 1, type: "LOWERCASE" },
    ],
  },
};

const exactly = (searchString: string, fieldToMatch: FieldToMatch): ByteMatch => ({
  byteMatchStatement: { searchString, positionalConstraint: "EXACTLY", fieldToMatch, textTransformations: [{ priority: 0, type: "NONE" }] },
});

/** `GET /signup`: the document request the challenge interstitial answers. */
export const SIGNUP_DOCUMENT_MATCH = { andStatement: { statements: [exactly("GET", { method: {} }), exactly(EDGE_WAF.signupDocumentPath, { uriPath: {} })] } };

/** The four rules of ADR-0015 §3.3, in priority order. */
export function edgeWafRules(): WafRule[] {
  const immunity = { immunityTimeProperty: { immunityTime: EDGE_WAF.challengeImmunitySeconds } };
  return [
    {
      name: "IpReputation",
      priority: 0,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { ...IP_REPUTATION_GROUP } },
      visibilityConfig: visibility("IpReputation"),
    },
    {
      name: "SignupRate",
      priority: 1,
      action: { block: {} },
      statement: { rateBasedStatement: { limit: EDGE_WAF.signupRateLimit, aggregateKeyType: "IP", evaluationWindowSec: EDGE_WAF.rateWindowSeconds, scopeDownStatement: SIGNUP_PATH_MATCH } },
      visibilityConfig: visibility("SignupRate"),
    },
    {
      name: "ApiRate",
      priority: 2,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: EDGE_WAF.apiRateLimit,
          aggregateKeyType: "IP",
          evaluationWindowSec: EDGE_WAF.rateWindowSeconds,
          scopeDownStatement: {
            byteMatchStatement: { searchString: EDGE_WAF.apiPrefix, positionalConstraint: "STARTS_WITH", fieldToMatch: { uriPath: {} }, textTransformations: [{ priority: 0, type: "NONE" }] },
          },
        },
      },
      visibilityConfig: visibility("ApiRate"),
    },
    {
      name: "SignupChallenge",
      priority: 3,
      action: { challenge: {} },
      challengeConfig: immunity,
      statement: { orStatement: { statements: [SIGNUP_DOCUMENT_MATCH, SIGNUP_PATH_MATCH] } },
      visibilityConfig: visibility("SignupChallenge"),
    },
  ];
}

export interface WebAclSettings {
  readonly name: string;
  readonly scope: typeof WEB_ACL_SCOPE;
  readonly description: string;
  readonly defaultAction: { allow: Record<string, never> };
  readonly rules: WafRule[];
  readonly challengeConfig: { immunityTimeProperty: { immunityTime: number } };
  readonly visibilityConfig: { cloudwatchMetricsEnabled: true; metricName: string; sampledRequestsEnabled: true };
}

/** What infra/edge-waf.ts lays over the web ACL the Router creates: every rule SST would add is replaced. */
export function webAclSettings(app: string, stage: string): WebAclSettings {
  return {
    name: webAclName(app, stage),
    scope: WEB_ACL_SCOPE,
    description: "Edge of the console: IP reputation, rate limits and a silent challenge on the signup.",
    defaultAction: { allow: {} },
    rules: edgeWafRules(),
    challengeConfig: { immunityTimeProperty: { immunityTime: EDGE_WAF.challengeImmunitySeconds } },
    visibilityConfig: visibility("WebAcl"),
  };
}

/**
 * Monthly cost (us-east-1, 2026-09-26, ADR-0015 §3.3): US$ 5 the web ACL + US$ 1 per rule + US$ 0.60 per
 * million requests + the price per 1,000 challenge responses, budgeted at its ceiling (US$ 1) until
 * docs/pending.md P-07.1 confirms it. Below 100,000 requests and 2,000 challenges a month. Recorded for
 * the rate card of WP-41.
 */
export const EDGE_WAF_MONTHLY_COST_USD = { min: 9.4, max: 11 } as const;
