// Guards of the CI bootstrap (infra/bootstrap/ci-role.yaml) and of the deploy workflow. They read
// the files as text on purpose (the repository has no YAML parser and needs none): each check is a
// line someone under pressure would be tempted to write, and must not.
import { describe, expect, it } from "vitest";
import { allows, block, deployWorkflow, parameterBlock, read, statement, template } from "./template-text";

const TRUSTS = {
  deploy: block(template, "  DeployRole:", "ManagedPolicyArns:"),
  "qa-runner": block(template, "  QaRunnerRole:", "      Policies:"),
};

describe.each(Object.entries(TRUSTS))("trust of the %s role", (_role, trust) => {

  it("matches the sub claim exactly, never with a wildcard", () => {
    expect(trust).toContain("StringEquals:");
    expect(trust).not.toMatch(/StringLike|ArnLike/);
    const subs = trust.split("\n").filter((line) => line.includes('"repo:'));
    expect(subs).toHaveLength(2);
    for (const sub of subs) {
      expect(sub).toContain(":ref:refs/heads/${DeployBranch}");
      expect(sub).not.toContain("*");
    }
  });

  it("accepts the id-bearing sub of repositories created after 2026-07-15", () => {
    expect(trust).toContain("repo:${GitHubOrg}@${GitHubOrgId}/${GitHubRepo}@${GitHubRepoId}:ref:refs/heads/${DeployBranch}");
  });

  it("binds the workflow file on the deploy branch", () => {
    expect(trust).toContain("token.actions.githubusercontent.com:job_workflow_ref:");
    expect(trust).toContain('/.github/workflows/deploy.yml@refs/heads/${DeployBranch}"');
  });

  it("always binds the immutable repository and owner ids", () => {
    expect(trust).toContain("token.actions.githubusercontent.com:repository_id: !Ref GitHubRepoId");
    expect(trust).toContain("token.actions.githubusercontent.com:repository_owner_id: !Ref GitHubOrgId");
    expect(trust).not.toContain("AWS::NoValue");
  });

});

describe("qa-runner session", () => {
  it("lasts as long as the scenarios job may run (120 min), and the workflow asks for exactly that", () => {
    expect(block(template, "  QaRunnerRole:", "AssumeRolePolicyDocument:")).toContain("MaxSessionDuration: 7200");
    expect(read(".github/workflows/scenarios.yml")).toMatch(/role-duration-seconds: 7200\b/);
    expect(read(".github/workflows/scenarios.yml")).toMatch(/timeout-minutes: 120\b/);
  });
});

describe("repository parameters", () => {
  it.each(["GitHubOrgId", "GitHubRepoId"])("makes %s mandatory and numeric", (parameter) => {
    const definition = parameterBlock(parameter);
    expect(definition).toContain('AllowedPattern: "^[0-9]+$"');
    expect(definition).not.toMatch(/^\s*Default:/m);
  });
});

describe("deploy workflow", () => {
  it("declares no environment, which would change the sub claim the trust expects", () => {
    expect(deployWorkflow).not.toMatch(/^\s*environment:/m);
  });

  it("assumes the role through OIDC and never with access keys", () => {
    expect(deployWorkflow).toContain("id-token: write");
    expect(deployWorkflow).toContain("role-to-assume:");
    expect(deployWorkflow).not.toMatch(/aws-access-key-id|aws-secret-access-key|AWS_SECRET_ACCESS_KEY/);
  });
});

describe("permissions of the deploy role and of the boundary", () => {
  it("defaults to the names of this app (docs/reuse-map.md, bootstrap row)", () => {
    for (const [name, value] of [
      ["AppName", "aws-cds-hackathon-poc-legajo"],
      ["BucketPrefix", "aws-cds-hackathon-poc-leg"],
      ["DeployStage", "poc"],
      ["AppDomain", "legajo.demo.craftech.io"],
      ["AgentNamePrefix", "aws_cds_hackathon_poc_legajo"],
      ["GitHubRepo", "aws-cds-hackathon-poc-legajo"],
    ] as const) {
      expect(parameterBlock(name), name).toContain(`Default: ${value}`);
    }
  });

  it("stays under the size CloudFormation accepts for an inline template body", () => {
    // `aws cloudformation deploy --template-file` needs an S3 bucket above 51,200 bytes; the
    // bootstrap must stay a single command with no prerequisites.
    expect(Buffer.byteLength(read("infra/bootstrap/ci-role.yaml"), "utf8")).toBeLessThan(51_200);
  });

  it("never opens the sst dev bridge: this app has no local stage", () => {
    expect(template).not.toContain("aws:PrincipalTag/sst:stage");
    expect(template).not.toContain("appsync:");
    const createRole = block(template, "Sid: IamCreateAppRolesWithBoundary", "- Sid: IamEditPoliciesOfBoundedAppRoles");
    expect(createRole).toContain("aws:RequestTag/sst:stage: !Ref DeployStage");
    expect(template).toContain("Sid: DenyRoleTagsOfOtherStages");
  });

  it("has no statement over every action", () => {
    expect(template).not.toMatch(/^\s*Action:\s*["']?\*["']?\s*$/m);
    expect(template).not.toMatch(/^\s*-\s*["']\*["']\s*$/m);
  });

  it("keeps the deploy role out of other projects' SST state", () => {
    expect(template).toContain("s3:::sst-state-*/*/${AppName}/*");
    expect(template).not.toMatch(/s3:::sst-state-\*\/\*"/);
  });

  it("fences IAM by the path of the app and forces the boundary on every new role", () => {
    const createRole = block(template, "Sid: IamCreateAppRolesWithBoundary", "- Sid: IamEditPoliciesOfBoundedAppRoles");
    expect(createRole).toContain("role/${AppName}/*");
    expect(createRole).toContain("iam:PermissionsBoundary: !Ref DeployBoundary");
    const outside = block(template, "Sid: DenyIamOutsideAppPath", "- Sid: DenyBoundaryRemovalOrSwap");
    expect(outside).toContain("NotResource:");
    for (const action of ["iam:UpdateAssumeRolePolicy", "iam:PassRole", "iam:AttachRolePolicy", "iam:PutRolePolicy", "sts:AssumeRole"]) {
      expect(outside).toContain(action);
    }
  });

  it("denies the administrative AWS managed policies", () => {
    const deny = block(template, "Sid: DenyAdministrativeManagedPolicies", "- Sid: DenyChangesToBootstrapResources");
    for (const policy of ["AdministratorAccess", "IAMFullAccess", "PowerUserAccess"]) {
      expect(deny).toContain(`policy/${policy}`);
    }
  });

  it("denies IAM management and role assumption to every role the app creates", () => {
    const boundary = block(template, "  DeployBoundary:", "  DeploySstHomePolicy:");
    const deny = block(boundary, "Sid: DenyIamManagementAndRoleAssumption", "- Sid: DenyPassingRolesOfOtherProjects");
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain("iam:Update*");
    expect(deny).toContain("sts:AssumeRole");
    expect(boundary).toContain("aws:ResourceTag/sst:app: !Ref AppName");
  });

  it("hands the Harness role the ECR Public bearer token and nothing else of STS", () => {
    const bearer = block(template, "Sid: HarnessImagePullBearerToken", "- Sid: HarnessRuntimeLogGroups");
    expect(bearer).toContain("sts:AWSServiceName: ecr-public.amazonaws.com");
    expect(template.split("\n").filter((line) => line.includes("sts:GetServiceBearerToken"))).toHaveLength(1);
  });

  it("creates SES identities and configuration sets only when the request tags them as the app", () => {
    const create = block(template, "Sid: CreateTaggedAsThisApp", "- Sid: NamedAppResources");
    expect(create).toContain("ses:CreateEmailIdentity");
    expect(create).toContain("ses:CreateConfigurationSet");
    expect(create).toContain("aws:RequestTag/sst:app: !Ref AppName");
    expect(template).not.toMatch(/contact-list|ContactList|sms-voice|s3vectors|states:|transcribe/);
  });

  it("fences the runtime under the Harness by the name AgentCore gives it", () => {
    const runtime = block(template, "Sid: HarnessUnderlyingRuntime", "- Sid: AgentCoreUntaggableChildren");
    expect(runtime).toContain("runtime/harness_${AgentNamePrefix}*");
    expect(runtime).not.toMatch(/bedrock-agentcore:\*/);
  });
});

const FUNCTION_FENCE = 'function/${AppName}-${DeployStage}-*"';
const KVS_FENCE = "!GetAtt RouterKeyValueStore.Arn";
const CACHE_POLICY_FENCE = 'cache-policy/${RouterCachePolicyId}"';

describe("CloudFront parts of the Router (no tags, shared account)", () => {
  it("grants cloudfront:* only behind the sst:app tag and the store data plane only on its ARN", () => {
    for (const { sid, body } of allows) {
      if (/cloudfront:\*/.test(body)) expect(body, sid).toContain("aws:ResourceTag/sst:app: !Ref AppName");
      if (body.includes("cloudfront-keyvaluestore:")) expect(body, sid).toContain(`Resource: ${KVS_FENCE}`);
    }
  });

  it("has no wildcard over the functions, stores or policies of the account", () => {
    expect(template).not.toMatch(
      /:cloudfront::\$\{AWS::AccountId\}:(function|key-value-store|cache-policy|origin-access-control|origin-request-policy|response-headers-policy)\/\*"/,
    );
  });

  it("updates, publishes and deletes only the functions named after this app", () => {
    for (const action of ["cloudfront:UpdateFunction", "cloudfront:PublishFunction", "cloudfront:DeleteFunction"]) {
      for (const { sid, body } of allows.filter((candidate) => candidate.body.includes(action))) {
        expect(body, sid).toContain(`Resource: !Sub "arn:\${AWS::Partition}:cloudfront::\${AWS::AccountId}:${FUNCTION_FENCE}`);
      }
    }
    const deny = statement("DenyCloudFrontFunctionsOfOtherProjects");
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain(`NotResource: !Sub "arn:\${AWS::Partition}:cloudfront::\${AWS::AccountId}:${FUNCTION_FENCE}`);
    for (const action of ["cloudfront:UpdateFunction", "cloudfront:PublishFunction", "cloudfront:DeleteFunction"]) {
      expect(deny).toContain(action);
    }
  });

  it("writes routes only into the store the bootstrap creates, and never creates or deletes a store", () => {
    expect(block(template, "  RouterKeyValueStore:", "  DeployBoundary:")).toContain("Type: AWS::CloudFront::KeyValueStore");
    const deny = statement("DenyKeyValueStoresOfOtherProjects");
    expect(deny).toContain("Action: cloudfront-keyvaluestore:*");
    expect(deny).toContain(`NotResource: ${KVS_FENCE}`);
    const notOwned = statement("DenyCloudFrontPartsTheAppDoesNotOwn");
    for (const action of ["CreateKeyValueStore", "DeleteKeyValueStore", "UpdateKeyValueStore"]) {
      expect(notOwned).toContain(`cloudfront:${action}`);
      expect(allows.filter(({ body }) => body.includes(`cloudfront:${action}`))).toHaveLength(0);
    }
  });

  it("changes a cache policy only by the id the operator declares, none by default", () => {
    const parameter = block(template, "  RouterCachePolicyId:", "Conditions:");
    expect(parameter).toContain("Default: none");
    expect(parameter).toContain('AllowedPattern: "^(none|[0-9a-f]{8}-');
    for (const action of ["cloudfront:UpdateCachePolicy", "cloudfront:DeleteCachePolicy"]) {
      for (const { sid, body } of allows.filter((candidate) => candidate.body.includes(action))) {
        expect(body, sid).toContain(CACHE_POLICY_FENCE);
      }
      expect(statement("DenyCachePoliciesOfOtherProjects")).toContain(action);
    }
    expect(statement("DenyCachePoliciesOfOtherProjects")).toContain(`NotResource: !Sub`);
  });

  it("never updates or deletes response headers or origin request policies", () => {
    const notOwned = statement("DenyCloudFrontPartsTheAppDoesNotOwn");
    for (const part of ["ResponseHeadersPolicy", "OriginRequestPolicy"]) {
      for (const verb of ["Update", "Delete"]) {
        expect(notOwned).toContain(`cloudfront:${verb}${part}`);
        expect(allows.filter(({ body }) => body.includes(`cloudfront:${verb}${part}`))).toHaveLength(0);
      }
    }
    expect(notOwned).toContain('Resource: "*"');
  });

  it("manages origin access controls only through the justified wildcard statement of ADR-0015 §9", () => {
    const oac = statement("EdgeOriginAccessControls");
    expect(oac).toContain("Effect: Allow");
    for (const verb of ["Create", "Get", "Update", "Delete"]) {
      expect(oac).toContain(`- cloudfront:${verb}OriginAccessControl`);
      expect(statement("DenyCloudFrontPartsTheAppDoesNotOwn")).not.toContain(`cloudfront:${verb}OriginAccessControl`);
      expect(allows.filter(({ body }) => body.includes(`cloudfront:${verb}OriginAccessControl`)).map(({ sid }) => sid)).toEqual(["EdgeOriginAccessControls"]);
    }
    expect(oac.match(/- cloudfront:/g)).toHaveLength(4);
  });

  it("adds the invoke permissions of OAC only on the functions named after this app", () => {
    const invoke = statement("EdgeOacInvokePermissions");
    expect(invoke).toContain("- lambda:AddPermission");
    expect(invoke).toContain("- lambda:RemovePermission");
    expect(invoke).toContain(`Resource: !Sub "arn:\${AWS::Partition}:lambda:\${Region}:\${AWS::AccountId}:${FUNCTION_FENCE.replace("function/", "function:")}`);
    expect(invoke.match(/- lambda:/g)).toHaveLength(2);
  });

  it("attaches the edge policy to the deploy role", () => {
    expect(block(template, "ManagedPolicyArns:", "Tags:")).toContain("- !Ref DeployEdgePolicy");
  });
});

describe("AWS WAF of the edge (ADR-0015 §3.3 and §9)", () => {
  const WEB_ACL = 'wafv2:us-east-1:${AWS::AccountId}:global/webacl/${AppName}-${DeployStage}-*/*"';

  it("manages only the web ACLs named after this app and stage, scope CLOUDFRONT in us-east-1", () => {
    const acl = statement("EdgeWebAclOfThisApp");
    for (const action of ["CreateWebACL", "UpdateWebACL", "DeleteWebACL", "GetWebACL", "ListTagsForResource", "TagResource", "UntagResource"]) expect(acl).toContain(`- wafv2:${action}`);
    expect(acl.match(/- wafv2:/g)).toHaveLength(7);
    expect(acl).toContain(`Resource: !Sub "arn:\${AWS::Partition}:${WEB_ACL}`);
    expect(template).not.toMatch(/wafv2:\*/);
    expect(read("docs/architecture.md")).toContain("`arn:aws:wafv2:us-east-1:776805327629:global/webacl/aws-cds-hackathon-poc-legajo-poc-*/*`");
  });

  it("covers the fixed name of the web ACL (docs/architecture.md §1) with its ARN", () => {
    expect(read("docs/architecture.md")).toContain("| Web ACL de WAF (scope `CLOUDFRONT`) | `aws-cds-hackathon-poc-legajo-poc-edge` |");
    expect(allows.some(({ body }) => body.includes(WEB_ACL))).toBe(true);
  });

  it("reads AWS's managed rule groups through the justified wildcard statement only", () => {
    const reads = statement("EdgeWafManagedRuleReads");
    expect(reads).toContain("- wafv2:DescribeManagedRuleGroup");
    expect(reads).toContain("- wafv2:ListAvailableManagedRuleGroups");
    expect(reads.match(/- wafv2:/g)).toHaveLength(2);
    expect(reads).toContain('Resource: "*"');
  });

  it("lets CreateWebACL/UpdateWebACL reference AWS's managed rule sets, and nothing else of them", () => {
    const references = statement("EdgeWafManagedRuleReferences");
    expect(references).toContain("- wafv2:CreateWebACL");
    expect(references).toContain("- wafv2:UpdateWebACL");
    expect(references.match(/- wafv2:/g)).toHaveLength(2);
    expect(references).toContain('Resource: !Sub "arn:${AWS::Partition}:wafv2:us-east-1:*:global/managedruleset/*"');
    expect(references).not.toMatch(/webacl|rulegroup\/|ipset|regexpatternset/);
    const readme = read("infra/bootstrap/README.md");
    expect(readme.slice(readme.indexOf("### Statements over every resource"), readme.indexOf("## Apply"))).toContain("`EdgeWafManagedRuleReferences`");
    for (const doc of ["docs/architecture.md", "docs/adr/0015-alta-publica-de-invitados-y-leads.md"]) expect(read(doc), doc).toContain("`arn:aws:wafv2:us-east-1:*:global/managedruleset/*`");
  });

  it("associates the web ACL through the distribution, never with wafv2:AssociateWebACL", () => {
    expect(template).not.toContain("wafv2:AssociateWebACL");
    expect(template).not.toMatch(/wafv2:(Put|Delete)LoggingConfiguration|wafv2:CreateRuleGroup|wafv2:CreateIPSet/);
  });
});

/** Every Allow over `Resource: "*"`, each justified in infra/bootstrap/README.md ("Statements over every resource"). */
const WILDCARD_SIDS = [
  "TaggedAppResources",
  "NoResourceLevelRuntime",
  "HarnessImagePullBearerToken",
  "DecryptPassphraseThroughSsm",
  "CloudControlTransport",
  "CreateTaggedAsThisApp",
  "HarnessDependentCreates",
  "NoResourceLevelDeploy",
  "CloudFrontCreatesAndReads",
  "EdgeOriginAccessControls",
  "EdgeWafManagedRuleReads",
  "DnsLookups",
  "ReadLogsOfThisApp",
] as const;

describe("statements over every resource", () => {
  it("are exactly WILDCARD_SIDS, each with its justification in the README", () => {
    const wildcards = [...new Set(allows.filter(({ body }) => /Resource: "\*"/.test(body)).map(({ sid }) => sid))];
    expect(wildcards.sort()).toEqual([...WILDCARD_SIDS].sort());
    const readme = read("infra/bootstrap/README.md");
    const section = readme.slice(readme.indexOf("### Statements over every resource"), readme.indexOf("## Apply"));
    for (const sid of WILDCARD_SIDS) expect(section, sid).toContain(`\`${sid}\``);
  });
});

describe("tags as the fence", () => {
  it("never lets a request tag move a resource of another app into this one", () => {
    const create = statement("CreateTaggedAsThisApp");
    const tagActions = [...create.matchAll(/- ([\w-]+:(?:TagResource|TagQueue|AddTagsToCertificate))/g)].map((match) => match[1]);
    expect(tagActions.length).toBeGreaterThan(10);
    const deny = statement("DenyRetaggingOtherApps");
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain("aws:ResourceTag/sst:app: !Ref AppName");
    expect(block(deny, "StringNotEquals:", '"Null":')).toContain("aws:ResourceTag/sst:app");
    expect(deny).toContain('aws:ResourceTag/sst:app: "false"');
    for (const action of tagActions) expect(deny).toContain(`- ${action}`);
  });

  it("fences SNS topics and SQS queues by the app name, the only fence before they exist", () => {
    // The provider reads a named topic before creating it, so a tag condition can never pass there.
    const named = statement("TopicsAndQueuesOfThisApp");
    expect(named).toContain('sns:${Region}:${AWS::AccountId}:${AppName}-*"');
    expect(named).toContain('sqs:${Region}:${AWS::AccountId}:${AppName}-*"');
    expect(named).toContain('sns:${Region}:${AWS::AccountId}:${AppName}-wa-inbound"');
    expect(named).not.toMatch(/Resource: "\*"/);
    for (const action of ["sns:*", "sqs:*", "sns:Publish", "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:PurgeQueue"]) expect(named).not.toContain(`- ${action}\n`);
    expect(block(template, "ManagedPolicyArns:", "Tags:")).toContain("- !Ref DeployNamedResourcesPolicy");
  });

  it("reads log group tags account-wide but writes none of them outside the tag fence", () => {
    const reads = statement("LogGroupTagReads");
    expect(reads).toContain("- logs:ListTagsForResource");
    expect(reads).toContain("- logs:ListTagsLogGroup");
    expect(reads.match(/- logs:/g)).toHaveLength(2);
    expect(reads).not.toContain("logs:*");
  });

  it("grants the Cloud Control API under its real IAM prefix, limited to the region", () => {
    // `awsnative.*` resources go through Cloud Control, whose actions are `cloudformation:*Resource*`;
    // a `cloudcontrol:` action grants nothing and the deploy stops with AccessDenied.
    expect(template).not.toMatch(/-\s+cloudcontrol:/);
    const transport = statement("CloudControlTransport");
    for (const action of ["CreateResource", "GetResource", "UpdateResource", "DeleteResource", "GetResourceRequestStatus"]) {
      expect(transport).toContain(`- cloudformation:${action}`);
    }
    expect(transport).toContain("aws:RequestedRegion: !Ref Region");
    expect(transport).not.toContain("cloudformation:*");
    // The request log is account-wide: listing or cancelling would reach every project.
    for (const action of ["ListResources", "ListResourceRequests", "CancelResourceRequest"]) expect(transport).not.toContain(`cloudformation:${action}`);
  });

  it("keeps every managed policy under IAM's 6,144-character limit", () => {
    // IAM counts the rendered JSON without whitespace; !Sub expansion and JSON quoting add up to
    // ~14% over the YAML, so the YAML budget keeps a 20% margin.
    const names = ["DeployBoundary", "DeploySstHomePolicy", "DeployAppResourcesPolicy", "DeployNamedResourcesPolicy", "DeployEdgePolicy", "DeployDnsAndIamPolicy", "DeployRole"];
    expect(names.slice(0, -1).every((name) => template.includes(`  ${name}:\n    Type: AWS::IAM::ManagedPolicy`))).toBe(true);
    for (const [name, next] of names.slice(0, -1).map((name, index) => [name, names[index + 1] ?? ""] as const)) {
      const document = block(block(template, `  ${name}:`, `  ${next}:`), "PolicyDocument:", "\n\n");
      expect(document.replace(/\s/g, "").length * 1.2, name).toBeLessThan(6_144);
    }
  });
});
