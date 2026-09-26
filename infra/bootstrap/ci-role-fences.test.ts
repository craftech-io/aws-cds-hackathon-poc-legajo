import { describe, expect, it } from "vitest";
import { block, read, statement, statements, template } from "./template-text";

describe("fixed names of docs/architecture.md §1", () => {
  const PREFIX = "arn:${AWS::Partition}:";
  // Every fixed name, with the exact ARN (template form) a statement must name.
  const FIXED: ReadonlyArray<readonly [string, string, string]> = [
    ["aws-cds-hackathon-poc-legajo-inbound", "receipt rule set", `${PREFIX}ses:\${Region}:\${AWS::AccountId}:receipt-rule-set/\${AppName}-inbound"`],
    ["aws-cds-hackathon-poc-leg-inbound-mail-776805327629", "inbound mail bucket", `${PREFIX}s3:::\${BucketPrefix}-inbound-mail-\${AWS::AccountId}"`],
    ["aws-cds-hackathon-poc-legajo-wa-inbound", "WhatsApp topic", `${PREFIX}sns:\${Region}:\${AWS::AccountId}:\${AppName}-wa-inbound"`],
    ["aws-cds-hackathon-poc-legajo-github-deploy", "deploy role", `${PREFIX}iam::\${AWS::AccountId}:role/\${AppName}-github-deploy"`],
    ["aws-cds-hackathon-poc-legajo-qa-runner", "qa-runner role", `${PREFIX}iam::\${AWS::AccountId}:role/\${AppName}-qa-runner"`],
    ["aws-cds-hackathon-poc-legajo-ci-boundary", "boundary", `${PREFIX}iam::\${AWS::AccountId}:policy/\${AppName}-ci-boundary"`],
    ["/aws-cds-hackathon-poc-legajo/", "IAM path", `${PREFIX}iam::\${AWS::AccountId}:role/\${AppName}/*"`],
    ["aws-cds-hackathon-poc-legajo-poc-qa-driver", "QA function", `${PREFIX}lambda:\${Region}:\${AWS::AccountId}:function:\${AppName}-\${DeployStage}-qa-driver"`],
    ["aws-cds-hackathon-poc-legajo-email-poc", "email configuration set", `${PREFIX}ses:\${Region}:\${AWS::AccountId}:configuration-set/\${AppName}-email-\${DeployStage}"`],
    ["aws-cds-hackathon-poc-legajo-sim-poc", "simulator configuration set", `${PREFIX}ses:\${Region}:\${AWS::AccountId}:configuration-set/\${AppName}-sim-\${DeployStage}"`],
  ];
  const architecture = read("docs/architecture.md");

  it.each(FIXED)("%s (%s) is in docs/architecture.md and covered by a statement with its exact ARN", (name, _what, arn) => {
    expect(architecture).toContain(name);
    expect(statements.some(({ body }) => body.includes(arn)), arn).toBe(true);
  });
});

describe("qa-runner", () => {
  const role = block(template, "  QaRunnerRole:", "Outputs:");

  it("only invokes the QA driver of the deploy stage and reads the app's logs", () => {
    const actions = [...role.matchAll(/Action: ([\w:-]+)/g)].map((match) => match[1]);
    expect([...new Set(actions)].sort()).toEqual(["lambda:InvokeFunction", "logs:FilterLogEvents", "sts:AssumeRoleWithWebIdentity"]);
    expect(statement("InvokeTheQaDriverOnly")).toContain("function:${AppName}-${DeployStage}-qa-driver");
    expect(statement("ReadLogsOfThisApp")).toContain("aws:ResourceTag/sst:app: !Ref AppName");
  });

  it("trusts deploy.yml and scenarios.yml on main, nothing else", () => {
    const refs = role.split("\n").filter((line) => line.includes("job_workflow_ref") || line.includes(".github/workflows/"));
    expect(refs.join("\n")).toContain("deploy.yml@refs/heads/${DeployBranch}");
    expect(refs.join("\n")).toContain("scenarios.yml@refs/heads/${DeployBranch}");
    expect(refs.filter((line) => line.includes(".github/workflows/"))).toHaveLength(2);
  });
});

describe("services this app adds to the scaffolding", () => {
  it("fences the Feeds event buses by the app name", () => {
    const buses = statement("EventBusesOfThisApp");
    for (const action of ["events:CreateEventBus", "events:DeleteEventBus", "events:TagResource"]) expect(buses).toContain(action);
    expect(buses).toContain('event-bus/${AppName}-*"');
  });

  it("allows public (NONE) Function URLs only on the BFF and the upload page", () => {
    const deny = statement("DenyPublicFunctionUrlsBesidesTheEdge");
    expect(deny).toContain("Effect: Deny");
    for (const action of ["lambda:CreateFunctionUrlConfig", "lambda:UpdateFunctionUrlConfig", "lambda:AddPermission"]) expect(deny).toContain(action);
    expect(deny).toContain("lambda:FunctionUrlAuthType: NONE");
    expect(deny).toContain("function:${AppName}-${DeployStage}-BffFunction-*");
    expect(deny).toContain("function:${AppName}-${DeployStage}-PublicWebFunction-*");
  });

  it("manages only the project's budget and denies every other", () => {
    expect(statement("ProjectBudget")).toContain('budget/${AppName}-*"');
    const deny = statement("DenyBudgetsOfOtherProjects");
    expect(deny).toContain("NotResource:");
    expect(deny).toContain('budget/${AppName}-*"');
    const deployDeny = block(block(template, "  DeployDnsAndIamPolicy:", "  DeployRole:"), "Sid: DenyAccountOrganizationAndBilling", "- Sid: DenyBudgetsOfOtherProjects");
    expect(deployDeny).not.toContain("budgets:*");
  });

  it("creates the GuardDuty malware protection plan only tagged as the app", () => {
    expect(statement("CreateTaggedAsThisApp")).toContain("guardduty:CreateMalwareProtectionPlan");
    const deployTagged = block(block(template, "  DeployAppResourcesPolicy:", "  DeployNamedResourcesPolicy:"), "Sid: TaggedAppResources", "- Sid: CreateTaggedAsThisApp");
    expect(deployTagged).toContain("guardduty:*");
    expect(deployTagged).toContain("aws:ResourceTag/sst:app: !Ref AppName");
    expect(statement("DenyRetaggingOtherApps")).toContain("guardduty:TagResource");
    expect(statement("GuardDutyMalwareScanRule")).toContain("rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*");
  });

  it("lets runtime roles send WhatsApp only from this account's phone numbers", () => {
    const whatsapp = statement("WhatsAppOfThisAccount");
    expect(whatsapp).toContain("social-messaging:SendWhatsAppMessage");
    expect(whatsapp).toContain('phone-number-id/*"');
    expect(whatsapp).not.toContain("social-messaging:*");
  });

  it("fences the receipt rule set by its fixed name and reads the active one account-wide", () => {
    const rules = statement("SesReceiptRuleSetOfThisApp");
    expect(rules).toContain("ses:SetActiveReceiptRuleSet");
    expect(rules).not.toContain('Resource: "*"');
    expect(statement("NoResourceLevelDeploy")).toContain("ses:DescribeActiveReceiptRuleSet");
  });
});
