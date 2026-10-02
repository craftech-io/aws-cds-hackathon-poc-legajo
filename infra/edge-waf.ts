// AWS WAF at the edge (ADR-0015 §3.3, docs/architecture.md §10 and §13, docs/build-plan.md WP-51).
//
// The web ACL is the one the SST Router creates with its `waf` argument (the `sst.aws` component that
// exists for it): the Router builds it in us-east-1 with scope CLOUDFRONT and associates it with its
// distribution (`webAclId`). infra/web.ts passes `waf: true` and `transform.waf: applyEdgeWaf`, which
// replaces SST's default rules (rate limit and three managed groups) with the four rules of
// infra/edge-waf-spec.ts and gives the ACL its fixed name, `aws-cds-hackathon-poc-legajo-poc-edge`,
// inside the deploy role's `wafv2` fence (infra/bootstrap/ci-role.yaml). No logging configuration
// (logs would carry IPs); the per-rule metrics in `AWS/WAFV2` are free.
//
// Cost: US$ 9.4 to 11 a month at the expected volume (edge-waf-spec.ts `EDGE_WAF_MONTHLY_COST_USD`).
//
// Verify (docs/architecture.md §15 step 6):
//   aws --profile craftech-demos wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1
//   aws --profile craftech-demos wafv2 get-web-acl --scope CLOUDFRONT --region us-east-1 \
//     --name aws-cds-hackathon-poc-legajo-poc-edge --id <id>        → the four rules, ChallengeConfig 3600
//   aws --profile craftech-demos cloudfront get-distribution-config --id <distribution> \
//     --query DistributionConfig.WebACLId                            → the ARN of that web ACL

import { webAclSettings } from "./edge-waf-spec";

/** `transform.waf` of the Router: every value of the web ACL comes from edge-waf-spec.ts. */
export function applyEdgeWaf(args: aws.wafv2.WebAclArgs): undefined {
  const settings = webAclSettings($app.name, $app.stage);
  args.name = settings.name;
  args.scope = settings.scope;
  args.description = settings.description;
  args.defaultAction = settings.defaultAction;
  args.rules = settings.rules;
  args.challengeConfig = settings.challengeConfig;
  args.visibilityConfig = settings.visibilityConfig;
}
