// The web ACL of the user pool (infra/auth-waf-spec.ts, ADR-0015 §3.3): per-IP limits on the two
// operations that send an email from the public client (the calls of `SignupDispatch` left out) and on
// the sign-in operations.
import { describe, expect, it } from "vitest";
import { COGNITO_CALLER_HEADER, cognitoCallerTag, deriveSubkey } from "../packages/bff/src/lib/crypto";
import { AUTH_WAF, authWafRules, authWebAclName, authWebAclSettings } from "./auth-waf-spec";

const TAG = cognitoCallerTag(deriveSubkey("0123456789abcdef0123456789abcdef0123456789ab", "cognito-caller"));

describe("[FL-113] web ACL of the user pool", () => {
  it("is REGIONAL, allows by default and has the fixed name of docs/architecture.md §1", () => {
    const settings = authWebAclSettings("aws-cds-hackathon-poc-legajo", "poc");
    expect(settings).toMatchObject({ name: "aws-cds-hackathon-poc-legajo-poc-auth", scope: "REGIONAL", defaultAction: { allow: {} } });
    expect(authWebAclName("app", "poc")).toBe("app-poc-auth");
  });

  it("limits ForgotPassword and ResendConfirmationCode per IP to 10 in 10 minutes, then blocks", () => {
    const rules = authWafRules(TAG);
    expect(rules.map((rule) => [rule.name, rule.priority])).toEqual([
      ["ForgotPasswordRate", 0],
      ["ResendCodeRate", 1],
      ["SignInRate", 2],
      ["IpReputation", 3],
    ]);
    for (const [rule, operation] of [
      [rules[0], "ForgotPassword"],
      [rules[1], "ResendConfirmationCode"],
    ] as const) {
      expect(rule?.action).toEqual({ block: {} });
      const statement = rule?.statement;
      if (statement === undefined || !("rateBasedStatement" in statement)) throw new Error("a rate rule");
      expect(statement.rateBasedStatement).toMatchObject({ limit: 10, aggregateKeyType: "IP", evaluationWindowSec: 600 });
      const scope = statement.rateBasedStatement.scopeDownStatement;
      if (!("andStatement" in scope)) throw new Error("operation and not the caller");
      const [op, notCaller] = scope.andStatement.statements;
      expect(op.byteMatchStatement).toMatchObject({ searchString: operation, positionalConstraint: "EXACTLY", fieldToMatch: { singleHeader: { name: "x-amzn-cognito-operation-name" } } });
      expect(notCaller.notStatement.statement.byteMatchStatement).toMatchObject({ searchString: TAG, positionalConstraint: "EXACTLY", fieldToMatch: { singleHeader: { name: COGNITO_CALLER_HEADER } } });
    }
    // WAF's limits: at least 10 per window, windows of 60, 120, 300 or 600 seconds.
    expect(AUTH_WAF.ratePerIp).toBeGreaterThanOrEqual(10);
    expect([60, 120, 300, 600]).toContain(AUTH_WAF.rateWindowSeconds);
  });

  it("limits InitiateAuth and RespondToAuthChallenge together per IP to 100 in 5 minutes, with no exemption", () => {
    const rule = authWafRules(TAG)[2];
    expect(rule?.action).toEqual({ block: {} });
    const statement = rule?.statement;
    if (statement === undefined || !("rateBasedStatement" in statement)) throw new Error("a rate rule");
    expect(statement.rateBasedStatement).toMatchObject({ limit: 100, aggregateKeyType: "IP", evaluationWindowSec: 300 });
    const scope = statement.rateBasedStatement.scopeDownStatement;
    if (!("orStatement" in scope)) throw new Error("either sign-in operation");
    expect(scope.orStatement.statements.map((match) => match.byteMatchStatement.searchString)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    expect(JSON.stringify(scope)).not.toContain(COGNITO_CALLER_HEADER);
  });

  it("blocks the IP reputation list and refuses a caller tag that is not a derived secret", () => {
    expect(authWafRules(TAG)[3]).toMatchObject({ overrideAction: { none: {} }, statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesAmazonIpReputationList" } } });
    expect(() => authWafRules("short")).toThrow(RangeError);
    expect(TAG).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
