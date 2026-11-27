// AWS WAF at the edge (ADR-0015 §3.3 amendment of 2026-11-27, docs/architecture.md §10 and §13): the
// web ACL every demo of the account shares, `demos-borde` (infra/edge-waf-spec.ts), looked up by name
// on every deploy; infra/web.ts puts its ARN on the Router's distribution. This app creates no edge
// web ACL any more (the deploy deletes the former `<app>-<stage>-edge`) and never changes the shared one.
// The deploy role reads it through `EdgeWebAclLookup` and `EdgeSharedWebAcl` (infra/bootstrap/ci-role.yaml).
//
// Verify (docs/architecture.md §15 step 6):
//   aws --profile craftech-demos wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1   → demos-borde, no …-poc-edge
//   aws --profile craftech-demos cloudfront get-distribution-config --id <distribution> \
//     --query DistributionConfig.WebACLId                                                    → the ARN of demos-borde

import { SHARED_EDGE_WEB_ACL, WEB_ACL_SCOPE } from "./edge-waf-spec";

export const sharedEdgeWebAcl = aws.wafv2.getWebAclOutput({ name: SHARED_EDGE_WEB_ACL, scope: WEB_ACL_SCOPE });
