// The deploy role and the REGIONAL web ACL of the user pool (infra/auth-waf.ts, ADR-0015 §3.3): the
// ACL named after this app and stage only, its association with the pool, and AWS's managed rule sets
// only through CreateWebACL and UpdateWebACL.
import { describe, expect, it } from "vitest";
import { block, read, statement, template } from "./template-text";

const WEB_ACL = 'wafv2:${Region}:${AWS::AccountId}:regional/webacl/${AppName}-${DeployStage}-auth/*"';

describe("AWS WAF of the user pool", () => {
  it("manages and associates only the web ACL <app>-<stage>-auth, in the stage's region", () => {
    const acl = statement("CognitoWebAclOfThisApp");
    const actions = ["AssociateWebACL", "CreateWebACL", "DeleteWebACL", "DisassociateWebACL", "GetWebACL", "GetWebACLForResource", "ListTagsForResource", "TagResource", "UntagResource", "UpdateWebACL"];
    for (const action of actions) expect(acl).toContain(`- wafv2:${action}`);
    expect(acl.match(/- wafv2:/g)).toHaveLength(actions.length);
    expect(acl).toContain(`Resource: !Sub "arn:\${AWS::Partition}:${WEB_ACL}`);
    expect(block(template, "  DeployEdgePolicy:", "  DeployDnsAndIamPolicy:")).toContain("Sid: CognitoWebAclOfThisApp");
  });

  it("lets CreateWebACL/UpdateWebACL reference AWS's regional managed rule sets, and nothing else of them", () => {
    const references = statement("CognitoWafManagedRuleReferences");
    expect(references).toContain("- wafv2:CreateWebACL");
    expect(references).toContain("- wafv2:UpdateWebACL");
    expect(references.match(/- wafv2:/g)).toHaveLength(2);
    expect(references).toContain('Resource: !Sub "arn:${AWS::Partition}:wafv2:${Region}:*:regional/managedruleset/*"');
    expect(references).not.toMatch(/webacl|rulegroup\/|ipset|regexpatternset/);
  });

  it("is named in docs/architecture.md §1 and the bootstrap README", () => {
    expect(read("docs/architecture.md")).toContain("| Web ACL de WAF (scope `REGIONAL`, user pool) | `aws-cds-hackathon-poc-legajo-poc-auth` |");
    expect(read("infra/bootstrap/README.md")).toContain("`CognitoWafManagedRuleReferences`");
  });
});
