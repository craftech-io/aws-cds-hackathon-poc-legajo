// The web ACL of the user pool as plain data and pure functions (ADR-0015 §3.3, docs/architecture.md
// §10 and §13). No SST or Pulumi dependency: infra/auth-waf.ts creates the REGIONAL web ACL with these
// arguments and associates it with the pool; infra/auth-waf-spec.test.ts checks every value. The
// header name comes from packages/bff/src/lib/crypto.ts, the module that also derives its value.
//
// Why. The web client is public (the browser signs in with SRP and asks for a recovery code with
// `ForgotPassword`), so anyone can call `ForgotPassword` and `ResendConfirmationCode` straight against
// Cognito with its id. Without this ACL the only brake is the account-email cap of `AuthCustomMessage`.
//
// Four rules, in this order:
//   0 ForgotPasswordRate   `x-amzn-cognito-operation-name` = ForgotPassword: 10 per 10 min per IP (block)
//   1 ResendCodeRate       `x-amzn-cognito-operation-name` = ResendConfirmationCode: 10 per 10 min per IP
//                          (block); the browser never sends it, `SignupDispatch` does
//   2 SignInRate           InitiateAuth or RespondToAuthChallenge: 100 per 5 min per IP (block). A sign-in
//                          is one of each and a session refreshes its tokens with one InitiateAuth every
//                          15 min, so an office behind one address stays far below; a password guesser
//                          from one address gets about 50 tries per 5 min on top of Cognito's own lockout
//   3 IpReputation         AWS managed list of IPs known for abuse (block)
// WAF's smallest rate limit is 10 per window; over its longest window (600 s) that is the 5 per 5 min of
// ADR-0015. Calls of `SignupDispatch` (the resend of a sign-up, the recovery code of an existing account)
// carry `x-legajo-caller` with a value derived from `SessionTokenKey` (subkey `cognito-caller`) and are
// left out of both rate rules: they all leave from the few addresses of one Lambda, and they are already
// counted by the sign-up's own limits (`SIGNUP_RATE_LIMITS`, `RESEND_MAX_PER_SIGNUP`).
//
// No logging configuration (logs would carry IPs); the per-rule metrics in `AWS/WAFV2` are free.

import { COGNITO_CALLER_HEADER } from "../packages/bff/src/lib/crypto";

export const AUTH_WEB_ACL_SCOPE = "REGIONAL";

/** Fixed name of the web ACL (docs/architecture.md §1), inside the deploy role's `CognitoWebAclOfThisApp` fence. */
export function authWebAclName(app: string, stage: string): string {
  return `${app}-${stage}-auth`;
}

export const AUTH_WAF = {
  /** WAF's longest evaluation window. */
  rateWindowSeconds: 600,
  /** WAF's smallest limit: 10 per 10 minutes, the 5 per 5 minutes of ADR-0015 §3.3. */
  ratePerIp: 10,
  /** Sign-in calls (InitiateAuth and RespondToAuthChallenge together) per IP per `signInWindowSeconds`. */
  signInsPerIp: 100,
  signInWindowSeconds: 300,
  operationHeader: "x-amzn-cognito-operation-name",
  /** Header of the calls of `SignupDispatch` (packages/bff/src/signup/cognito.ts). */
  callerHeader: COGNITO_CALLER_HEADER,
} as const;

export const RATE_LIMITED_OPERATIONS = { ForgotPasswordRate: "ForgotPassword", ResendCodeRate: "ResendConfirmationCode" } as const;
export const SIGN_IN_OPERATIONS = ["InitiateAuth", "RespondToAuthChallenge"] as const;

export const AUTH_IP_REPUTATION_GROUP = { vendorName: "AWS", name: "AWSManagedRulesAmazonIpReputationList" } as const;

/** Prefix of every CloudWatch metric the web ACL publishes (`AWS/WAFV2`, free). */
export const AUTH_WAF_METRIC_PREFIX = "LegajoAuth";

interface HeaderMatch {
  readonly byteMatchStatement: {
    readonly searchString: string;
    readonly positionalConstraint: "EXACTLY";
    readonly fieldToMatch: { singleHeader: { name: string } };
    readonly textTransformations: Array<{ priority: number; type: "NONE" }>;
  };
}

export interface AuthRateStatement {
  readonly rateBasedStatement: {
    readonly limit: number;
    readonly aggregateKeyType: "IP";
    readonly evaluationWindowSec: number;
    readonly scopeDownStatement: { andStatement: { statements: [HeaderMatch, { notStatement: { statement: HeaderMatch } }] } } | { orStatement: { statements: HeaderMatch[] } };
  };
}

type Visibility = { cloudwatchMetricsEnabled: true; metricName: string; sampledRequestsEnabled: true };

export interface AuthWafRule {
  readonly name: string;
  readonly priority: number;
  readonly action?: { block: Record<string, never> };
  readonly overrideAction?: { none: Record<string, never> };
  readonly statement: AuthRateStatement | { managedRuleGroupStatement: { vendorName: string; name: string } };
  readonly visibilityConfig: Visibility;
}

const visibility = (name: string): Visibility => ({ cloudwatchMetricsEnabled: true, metricName: `${AUTH_WAF_METRIC_PREFIX}${name}`, sampledRequestsEnabled: true });

const header = (name: string, value: string): HeaderMatch => ({
  byteMatchStatement: { searchString: value, positionalConstraint: "EXACTLY", fieldToMatch: { singleHeader: { name } }, textTransformations: [{ priority: 0, type: "NONE" }] },
});

function operationRate(operation: string, callerTag: string): AuthRateStatement {
  return {
    rateBasedStatement: {
      limit: AUTH_WAF.ratePerIp,
      aggregateKeyType: "IP",
      evaluationWindowSec: AUTH_WAF.rateWindowSeconds,
      scopeDownStatement: { andStatement: { statements: [header(AUTH_WAF.operationHeader, operation), { notStatement: { statement: header(AUTH_WAF.callerHeader, callerTag) } }] } },
    },
  };
}

const SIGN_IN_RATE: AuthRateStatement = {
  rateBasedStatement: {
    limit: AUTH_WAF.signInsPerIp,
    aggregateKeyType: "IP",
    evaluationWindowSec: AUTH_WAF.signInWindowSeconds,
    scopeDownStatement: { orStatement: { statements: SIGN_IN_OPERATIONS.map((operation) => header(AUTH_WAF.operationHeader, operation)) } },
  },
};

/** The four rules above, in priority order; `callerTag` is the value `SignupDispatch` sends in `x-legajo-caller`. */
export function authWafRules(callerTag: string): AuthWafRule[] {
  if (callerTag.length < 32) throw new RangeError("the caller tag must be a derived secret");
  const rules: Array<Omit<AuthWafRule, "priority" | "visibilityConfig">> = [
    ...Object.entries(RATE_LIMITED_OPERATIONS).map(([name, operation]) => ({ name, action: { block: {} }, statement: operationRate(operation, callerTag) })),
    { name: "SignInRate", action: { block: {} }, statement: SIGN_IN_RATE },
    { name: "IpReputation", overrideAction: { none: {} }, statement: { managedRuleGroupStatement: { ...AUTH_IP_REPUTATION_GROUP } } },
  ];
  return rules.map((rule, priority) => ({ ...rule, priority, visibilityConfig: visibility(rule.name) }));
}

export interface AuthWebAclSettings {
  readonly name: string;
  readonly scope: typeof AUTH_WEB_ACL_SCOPE;
  readonly description: string;
  readonly defaultAction: { allow: Record<string, never> };
  readonly visibilityConfig: Visibility;
}

export function authWebAclSettings(app: string, stage: string): AuthWebAclSettings {
  return {
    name: authWebAclName(app, stage),
    scope: AUTH_WEB_ACL_SCOPE,
    description: "User pool of the console: per-IP limits on recovery codes, code resends and sign-ins, IP reputation.",
    defaultAction: { allow: {} },
    visibilityConfig: visibility("WebAcl"),
  };
}

/** Monthly cost (us-east-1): US$ 5 the web ACL + US$ 1 per rule + US$ 0.60 per million requests. */
export const AUTH_WAF_MONTHLY_COST_USD = { min: 9, max: 9.5 } as const;
