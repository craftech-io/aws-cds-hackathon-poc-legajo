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
  ARN    fixed names: the inbound mail bucket
         <BucketPrefix>-inbound-mail-<account>, the WhatsApp topic <app>-wa-inbound, the
         configuration sets <app>-email-poc and <app>-sim-poc, the QA driver <app>-poc-qa-driver,
         the web ACL <app>-poc-edge, the Router key-value store and cache policy.
```

What each group of statements is for:

| Statement | Why |
|---|---|
| `TaggedAppResources` / `CreateTaggedAsThisApp` | Everything after creation only on resources tagged as the app; creation only when the request tags the new resource as the app |
| `NamedAppResources` | DynamoDB tables `<app>-*`, buckets `<BucketPrefix>*` and the fixed inbound mail bucket (S3 cannot be conditioned on tags) |
| `TopicsAndQueuesOfThisApp`, `SchedulerGroupsOfThisApp`, `EventBusesOfThisApp` | The provider reads a named topic, queue, group or bus before IAM can see its tags |
| `ProjectBudget` / `DenyBudgetsOfOtherProjects` | The monthly budget `<app>-*` of `docs/architecture.md` §12, and no other budget of the account |
| `DenyPublicFunctionUrlsBesidesTheEdge` | A Function URL with `AuthType NONE` only on `Bff` and `PublicWeb`; the mocks and every other function keep `AWS_IAM` |
| `GuardDutyMalwareScanRule` (boundary) | The managed EventBridge rule GuardDuty Malware Protection for S3 creates through the plan's role |
| `WhatsAppOfThisAccount` (boundary) | End User Messaging Social sends only from phone numbers of this account |
| `TranscribeVerificationCalls` (boundary) | `PhoneOtp` transcribes Meta's verification call: only `transcription-job/otp-*` |
| `ConnectServiceLinkedRole`, `ConnectServiceLinkedRolePolicies` | The Connect service-linked role (`aws-service-role/connect.amazonaws.com/*`): created once, and its inline policy updated when the recordings bucket is associated |
| `HarnessUnderlyingRuntime` | The runtime AgentCore creates under the Harness, named `harness_<AgentNamePrefix>*` |
| `CloudControlTransport` | `awsnative.*` resources go through the Cloud Control API, IAM prefix `cloudformation` |
| Edge policy | CloudFront functions `<app>-poc-*`, the bootstrap key-value store and the declared cache policy only |
| `EdgeWebAclOfThisApp` | The web ACL of ADR-0015 §3.3, only `global/webacl/<app>-poc-*/*` in us-east-1 (scope `CLOUDFRONT`); the association with the distribution goes through `cloudfront:UpdateDistribution`, already fenced by tag |
| `EdgeOacInvokePermissions` | `lambda:AddPermission`/`RemovePermission` for `cloudfront.amazonaws.com` on the functions `<app>-poc-*` (OAC of `Bff` and `PublicWeb`), by name, so it does not wait for the tag to be visible |

### Statements over every resource (`WILDCARD_SIDS`)

`ci-role.test.ts` fails when an `Allow` with `Resource: "*"` is not in this list, which it mirrors:

| Statement | Why it cannot name a resource |
|---|---|
| `TaggedAppResources` (deploy role and boundary) | Fenced by the `sst:app` tag of the resource instead |
| `CreateTaggedAsThisApp` | A create has no resource yet; fenced by the request tag |
| `HarnessDependentCreates` | AgentCore creates the runtime and Memory under the Harness; region condition |
| `NoResourceLevelDeploy`, `NoResourceLevelRuntime` | Listings and reads with no resource-level permission |
| `CloudFrontCreatesAndReads` | CloudFront creates and the account-wide reads of policies have no resource-level permission |
| `EdgeOriginAccessControls` | Origin access controls carry no tag and an opaque id: no fence by resource exists. SST's lazy Router (4.17.1) configures OAC per request inside its function and creates no OAC resource, so these actions are a reserve for the provider; ADR-0015 §9 keeps them |
| `EdgeWafManagedRuleReferences` | Not `"*"`, but over any account: `CreateWebACL` and `UpdateWebACL` also authorize the managed rule set a web ACL references, and the IP reputation list is owned by AWS, not by this account. Only those two actions, only `managedruleset/*`; the web ACL itself stays fenced by `EdgeWebAclOfThisApp` |
| `EdgeWafManagedRuleReads` | `DescribeManagedRuleGroup` and `ListAvailableManagedRuleGroups` read AWS's managed rule groups (the IP reputation list), which have no resource of the account |
| `DecryptPassphraseThroughSsm` | KMS through SSM only, of this account (`kms:ViaService`, `kms:CallerAccount`) |
| `CloudControlTransport` | The Cloud Control API authorizes by the type, not the resource; region condition |
| `DnsLookups` | `route53:GetChange` and `ListHostedZones` have no resource-level permission |
| `HarnessImagePullBearerToken` | STS bearer token, only for `ecr-public.amazonaws.com` |
| `ReadLogsOfThisApp` (qa-runner) | Fenced by the `sst:app` tag of the log group |
| `ConnectOfThisApp` (phone policy) | Amazon Connect of this app (instance, number, flow), fenced by the `sst:app` tag of the resource; `DenyRetaggingOtherConnect` keeps another project's instance out |
| `CreateConnectTaggedAsThisApp` | Creating the instance, claiming the number and creating the flow have no resource yet; fenced by the request tag |
| `ConnectWithoutResourceLevel` | `ListInstances`, `SearchAvailablePhoneNumbers` and `ListPhoneNumbersV2` have no resource-level permission; region condition |
| `DirectoryOfConnectInstances` | A `CONNECT_MANAGED` instance creates and deletes its own Directory Service directory, which has no ARN before it exists; region condition |

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
policy: IAM cannot change it in place and the replacement fails with `already exists`. The public
signup (wave 3) adds the `wafv2` and OAC statements: the operator applies the template again before
the first deploy of that wave.

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

Repeat with `cloudfront:UpdateFunction` on a function ARN of another project, with
`budgets:ModifyBudget` on another budget and with `wafv2:UpdateWebACL` on a web ACL of another
project (`arn:aws:wafv2:us-east-1:776805327629:global/webacl/<other>/<id>`). `simulate-principal-policy` does not model every
condition key, so a real deploy is the final check.

## Residual risks

Stated instead of hidden.

- **Connect service-linked roles.** `DenyIamOutsideAppPath` leaves out `aws-service-role/connect.amazonaws.com/*`,
  because associating the recordings bucket makes Connect write it into its service-linked role. Connect creates
  one such role per instance with a random suffix, unknown when the bootstrap is applied, so the fence is the
  service path: the deploy role could also edit the inline policy of another project's Connect instance role.

- **Active receipt rule set.** SES keeps one active rule set per region and account; activating
  ours deactivates any other. The receipt rule actions (`CreateReceiptRuleSet`, `SetActiveReceiptRuleSet`,
  `CreateReceiptRule`, …) have no resource-level permission in IAM (`iam simulate-custom-policy`
  matches them only on `*`), so they live in `NoResourceLevelDeploy`, limited to the region. The
  fence is procedural: the pre-check of step 0 and the `deploy.yml` step that stops before
  `sst deploy` unless the active rule set is none or `<app>-inbound`. The other projects of the
  account never receive email and own no rule set.
- **Demo recipients.** `ses:Recipients` in the runtime policies lists the simulated mailboxes and
  the SES mailbox simulator; the registered demo recipients of `SeedOverrides` are fenced in code
  (the recipient fence of the SES client), not in IAM, because the secret is not readable at
  deploy time.
- **Function URLs of the edge.** Since the public signup (ADR-0015 §3.1) the Router uses OAC:
  `Bff` and `PublicWeb` answer on `AWS_IAM` Function URLs that only CloudFront, for this
  distribution, may invoke; each handler also checks `X-Origin-Verify` first and then its own
  token. `DenyPublicFunctionUrlsBesidesTheEdge` still keeps `AuthType NONE` off every other
  function. The value of `X-Origin-Verify` is readable inside the account in the code of the
  Router's viewer-request function (`cloudfront:DescribeFunction`).
- **Origin access controls.** The four OAC actions cannot be fenced by resource
  (`EdgeOriginAccessControls`); the deploy role could change another project's OAC. The pinned
  Router creates none, so a later ADR can drop them.
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
