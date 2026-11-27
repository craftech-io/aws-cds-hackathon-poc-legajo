// AWS WAF of the user pool (ADR-0015 §3.3, docs/architecture.md §10 and §13): a REGIONAL web ACL with
// the rules of infra/auth-waf-spec.ts, associated with the pool of infra/auth.ts. `aws.wafv2.*` because
// no `sst.aws` component manages a web ACL outside the Router's; inside the deploy role's
// `CognitoWebAclOfThisApp` fence (infra/bootstrap/ci-role.yaml). The value of `x-legajo-caller` is
// derived from `SessionTokenKey` at deploy time, the same subkey `SignupDispatch` derives at run time.
//
// Cost: about US$ 9 a month (auth-waf-spec.ts `AUTH_WAF_MONTHLY_COST_USD`).
//
// Verify (docs/architecture.md §15 step 6):
//   aws --profile craftech-demos wafv2 list-web-acls --scope REGIONAL --region us-east-1
//   aws --profile craftech-demos wafv2 get-web-acl-for-resource --region us-east-1 --resource-arn <arn of the pool>
//     → aws-cds-hackathon-poc-legajo-poc-auth, rules ForgotPasswordRate, ResendCodeRate, SignInRate, IpReputation

import { cognitoCallerTag, deriveSubkey } from "../packages/bff/src/lib/crypto";
import { authWafRules, authWebAclSettings } from "./auth-waf-spec";
import { userPool } from "./auth";
import { SessionTokenKey } from "./secrets";

const settings = authWebAclSettings($app.name, $app.stage);

// The spec's shapes are the provider's JSON, nested level by level; handed over as is (auth-waf-spec.test.ts).
type ProviderRules = aws.types.input.wafv2.WebAclRule[];

export const authWebAcl = new aws.wafv2.WebAcl("AuthWebAcl", {
  name: settings.name,
  scope: settings.scope,
  description: settings.description,
  defaultAction: settings.defaultAction,
  visibilityConfig: settings.visibilityConfig,
  rules: $util.secret(SessionTokenKey.value).apply((master) => authWafRules(cognitoCallerTag(deriveSubkey(master, "cognito-caller"))) as unknown as ProviderRules),
});

export const authWebAclAssociation = new aws.wafv2.WebAclAssociation("AuthWebAclAssociation", {
  resourceArn: userPool.arn,
  webAclArn: authWebAcl.arn,
});
