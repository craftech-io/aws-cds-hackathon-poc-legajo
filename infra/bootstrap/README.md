# CI bootstrap

`ci-role.yaml` creates the only infrastructure that must exist before the first `sst deploy`
(ADR-0009, ADR-0005, `docs/architecture.md` §15 step 2):

- Permissions boundary `<app>-ci-boundary`, stamped on every role of the app by `infra/ci.ts`.
  Whatever policy a commit attaches, a role reaches only this app, one region, no IAM management
  and no role assumption.
- Deploy role `<app>-github-deploy`, assumed by `.github/workflows/deploy.yml` on `main`, with the
  managed policies `<app>-ci-deploy-{sst-home,app-resources,named,edge,dns-and-iam}`.
- Role `<app>-qa-runner`, assumed by `deploy.yml` (smoke) and `scenarios.yml` (full suite) on
  `main`: it can only invoke `function:<app>-poc-qa-driver` and read the app's logs.
- Key-value store `<app>-poc-router`, the routing table of the Router (`infra/web.ts`).
- Response headers policy `<app>-poc-console` (CSP, HSTS, `X-Frame-Options DENY`, nosniff,
  referrer), which the deploy role cannot change.
- Optionally the GitHub OIDC provider, only for an account that has none.

Explanations live here, not in the template: CloudFormation accepts 51,200 bytes inline and IAM
6,144 characters per managed policy (`ci-role.test.ts` checks both, plus every fixed name of
`docs/architecture.md` §1 against a statement with its exact ARN).

## How every statement is fenced

```text
The demos account is SHARED with other projects, so every statement is scoped to this app:

  tag    aws:ResourceTag/sst:app = <app>, stamped by the provider default tags (sst.config.ts)
         and by infra/tags.ts on awsnative.*. Used wherever the service authorizes by tag
         (Lambda, SQS, SNS, EventBridge, Scheduler, Cognito, SES, Bedrock, AgentCore, GuardDuty…).
  name   ARN prefix where the physical name keeps the app name whole (DynamoDB, SNS, SQS, event
         buses, schedule groups, the budget, CloudFront functions), where tags cannot be used (S3,
         by BucketPrefix) or are not there yet (reads before and right after a create).
  path   every IAM role and policy of the app lives under /<app>/ (infra/ci.ts). The path is part
         of the ARN and cannot be forged with a tag, so it fences IAM.
  ARN    fixed names: the receipt rule set <app>-inbound, the inbound mail bucket
         <BucketPrefix>-inbound-mail-<account>, the WhatsApp topic <app>-wa-inbound, the
         configuration sets <app>-email-poc and <app>-sim-poc, the QA driver <app>-poc-qa-driver,
         the Router key-value store and cache policy.
```

What each group of statements is for:

| Statement | Why |
|---|---|
| `TaggedAppResources` / `CreateTaggedAsThisApp` | Everything after creation only on resources tagged as the app; creation only when the request tags the new resource as the app |
| `NamedAppResources` | DynamoDB tables `<app>-*`, buckets `<BucketPrefix>*` and the fixed inbound mail bucket (S3 cannot be conditioned on tags) |
| `SesReceiptRuleSetOfThisApp` | Receipt rules only inside the rule set `<app>-inbound` |
| `TopicsAndQueuesOfThisApp`, `SchedulerGroupsOfThisApp`, `EventBusesOfThisApp` | The provider reads a named topic, queue, group or bus before IAM can see its tags |
| `ProjectBudget` / `DenyBudgetsOfOtherProjects` | The monthly budget `<app>-*` of `docs/architecture.md` §12, and no other budget of the account |
| `DenyPublicFunctionUrlsBesidesTheEdge` | A Function URL with `AuthType NONE` only on `Bff` and `PublicWeb`; the mocks and every other function keep `AWS_IAM` |
| `GuardDutyMalwareScanRule` (boundary) | The managed EventBridge rule GuardDuty Malware Protection for S3 creates through the plan's role |
| `WhatsAppOfThisAccount` (boundary) | End User Messaging Social sends only from phone numbers of this account |
| `HarnessUnderlyingRuntime` | The runtime AgentCore creates under the Harness, named `harness_<AgentNamePrefix>*` |
| `CloudControlTransport` | `awsnative.*` resources go through the Cloud Control API, IAM prefix `cloudformation` |
| Edge policy | CloudFront functions `<app>-poc-*`, the bootstrap key-value store and the declared cache policy only |

## Apply

Once per account, operator present, never from CI. First the read-only pre-checks of step 0
(SES in production, no foreign active rule set, OIDC provider, SST bootstrap, model, cost tag):

```bash
aws --profile craftech-demos sesv2 get-account
aws --profile craftech-demos ses describe-active-receipt-rule-set
aws --profile craftech-demos iam list-open-id-connect-providers
aws --profile craftech-demos ssm get-parameter --name /sst/bootstrap --query Parameter.Name
```

Then the repository ids (`gh api orgs/craftech-io --jq .id` → 60447213 and
`gh api repos/craftech-io/aws-cds-hackathon-poc-legajo --jq .id`) and the stack. Pass
`CreateOidcProvider=true` only when `token.actions.githubusercontent.com` is not listed.

```bash
aws --profile craftech-demos cloudformation deploy \
  --stack-name aws-cds-hackathon-poc-legajo-ci-bootstrap \
  --template-file infra/bootstrap/ci-role.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides CreateOidcProvider=false GitHubOrgId=60447213 GitHubRepoId=<id> \
  --tags Project=aws-cds-hackathon-poc-legajo ManagedBy=cloudformation Owner=craftech
```

The same command applies every later change. Edit statements, not the `Description` of a managed
policy: IAM cannot change it in place and the replacement fails with `already exists`.

The SST bootstrap of the account and the stage passphrase are created by the operator's first
`npx sst secret set ... --stage poc` (step 3), never by CI.

## Verify

```bash
aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-legajo-github-deploy
aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-legajo-qa-runner
aws --profile craftech-demos iam get-policy --policy-arn arn:aws:iam::776805327629:policy/aws-cds-hackathon-poc-legajo-ci-boundary
```

The deploy role must be denied on resources of another project of the shared account:

```bash
aws --profile craftech-demos iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-legajo-github-deploy \
  --action-names dynamodb:Scan dynamodb:DeleteTable \
  --resource-arns <arn of a table of another project>
```

Repeat with `cloudfront:UpdateFunction` on a function ARN of another project and with
`budgets:ModifyBudget` on another budget. `simulate-principal-policy` does not model every
condition key, so a real deploy is the final check.

## Residual risks

Stated instead of hidden.

- **Active receipt rule set.** SES keeps one active rule set per region and account; activating
  ours deactivates any other. The IAM fence limits the deploy role to the rule set
  `<app>-inbound`, but `SetActiveReceiptRuleSet` on it still deactivates the previous one. Mitigated
  by the pre-check of step 0 and by the `deploy.yml` step that stops when a foreign rule set is
  active. If SES answers AccessDenied on a receipt action because it has no resource-level
  permission, move that action to `NoResourceLevelDeploy` with its justification.
- **Demo recipients.** `ses:Recipients` in the runtime policies lists the simulated mailboxes and
  the SES mailbox simulator; the registered demo recipients of `SeedOverrides` are fenced in code
  (the recipient fence of the SES client), not in IAM, because the secret is not readable at
  deploy time.
- **Public Function URLs.** `Bff` and `PublicWeb` answer on Function URLs with `AuthType NONE`
  behind the Router; each one authenticates on its own (id token, upload token). Their names are
  fenced by `DenyPublicFunctionUrlsBesidesTheEdge`.
- **Tag on create.** A service authorizes `TagResource` during a create call with the request tags
  only, which IAM cannot tell apart from tagging an existing untagged resource. A resource of
  another SST app carries its own `sst:app`, which the role cannot overwrite
  (`DenyRetaggingOtherApps`); an untagged resource of the listed services could be claimed.
  Closing that needs one account per project or an SCP.
- **Account-wide actions** with no resource-level permissions (CloudFront creates,
  `sst-asset-*` objects, `ses:DescribeActiveReceiptRuleSet`, listings), each justified next to
  its statement.
- A missing permission fails closed: the deploy stops with AccessDenied naming the action. The
  fix is a new statement with its justification, scoped by tag, name, IAM path or ARN, never a
  broader wildcard.
