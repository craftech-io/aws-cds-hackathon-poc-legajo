// The console BFF, the importer's upload page, the QA driver and the daily policy audit
// (docs/architecture.md §10, §11, §12 and §14, ADR-0005, ADR-0015 §3 and §6, docs/build-plan.md WP-32).
//
//   Bff          tRPC v11 (packages/bff/src/routers/handler.ts) on the Router at `/api`: console,
//                public signup (`signup.*`), guest bootstrap (`account.*`), phone simulator. Runs the
//                world factory in process (WORLDS: first guest login, "Reiniciar demo", synthetic PDFs),
//                enqueues console sends and clock work, and invokes InboundWhatsApp (simulator), SimMail
//                (SIM_REPLY of a clock move), WorldJanitor (MEMORY_PURGE, GUEST_CREATE), SignupDispatch and LeadNotice. No SES, no
//                End User Messaging, no Guardrails (iam-capabilities.ts).
//   PublicWeb    the upload page `/u/<token>` (packages/bff/src/public-web/handler.ts), no login: Runtime,
//                AuditLog and the presigned POST to Uploads.
//   QaDriver     `<app>-<stage>-qa-driver`, no URL, invoked only by the bootstrap's `qa-runner` role
//                (ADR-0005, docs/test-plan.md §4.1): what the Bff has (it runs the real appRouter) fenced
//                by WORLDS to QA worlds, plus the QA sender, the channel entries, the reader, G1, the DLQ
//                and its alarm, and the SC-26 actions of the public signup (the only access to Leads).
//   PolicyAudit  re-evaluates every sent message (docs/architecture.md §12): daily by schedule
//                (observability-spec.ts POLICY_AUDIT) and on demand by the QaDriver.
//
// Edge (ADR-0015 §3.1, infra/web.ts): Bff and PublicWeb attach to the Router with `url.router`, so with
// the Router's `protection: "oac"` their Function URLs are AWS_IAM and only cloudfront.amazonaws.com with
// the distribution as SourceArn may invoke them; `authorization: "iam"` keeps the URL closed even if the
// Router ever lost its protection. The Router's viewer-request function adds `X-Origin-Verify` on `/api/*`
// and `/u/*`, and both handlers compare it with the linked `OriginVerifyKey` before anything else. The
// web ACL of infra/edge-waf.ts sits on the same distribution. Budgets and routes: web-spec.ts.
//
// Least privilege (iam-capabilities.ts, §14): data by `link` exactly as `storageLinks(fn)` says; the
// Platform table only by its fenced statement (`mockPermissions`); the signup and leads only by
// `signupGrants(fn)` of infra/leads.ts (Bff and QaDriver here, WorldJanitor in infra/scheduler.ts);
// every invoked Function by linking it (a linked Function grants `lambda:InvokeFunction` on it alone).
// The DLQ alarm comes late from infra/observability.ts, which imports this module.
//
// Secrets travel only as links (SST encrypts them in the bundle); no Function here has `environment`.
//
// Verify:
//   curl -s https://legajo.demo.craftech.io/api/health                                        → 200
//   curl -s -o /dev/null -w "%{http_code}" https://legajo.demo.craftech.io/u/invalid           → 404 page
//   aws --profile craftech-demos lambda get-function-url-config --function-name <Bff or PublicWeb name>  → AuthType AWS_IAM
//   curl -s -o /dev/null -w "%{http_code}" <Function URL of Bff or PublicWeb>                  → 403
//   aws --profile craftech-demos lambda get-function-concurrency --function-name <Bff name>   → 10 (PublicWeb 5)
//   aws --profile craftech-demos lambda get-function-configuration --function-name <Bff name> --query Environment
//     → only SST_KEY and SST_KEY_FILE, never a secret value
//   aws --profile craftech-demos lambda get-policy --function-name aws-cds-hackathon-poc-legajo-poc-qa-driver
//     → lambda:InvokeFunction for the qa-runner role only
//   aws --profile craftech-demos iam simulate-principal-policy --policy-source-arn <QaDriver role ARN> \
//     --action-names dynamodb:PutItem --resource-arns <PlatformData ARN> --context-entries \
//     ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=POP#firm-delta#4471,ContextKeyType=stringList
//     → implicitDeny (a non QA world), and the same for a table ARN of another project
//   aws --profile craftech-demos events list-rule-names-by-target --target-arn <PolicyAudit ARN>  → the daily rule

import { Agent } from "./agentcore";
import { Auth } from "./auth";
import { qaRunnerRoleArn } from "./ci";
import { ChannelModes } from "./channel-modes";
import { GuardrailG1 } from "./guardrail";
import type { LambdaName } from "./iam-capabilities";
import { lateLinks, links } from "./late-links";
import { signupGrants } from "./leads";
import { emailLinks, inboundEmail, simMail } from "./messaging-email";
import { inboundWhatsApp } from "./messaging-whatsapp";
import { grantMockInvoke, mockLinks, mockPermissions } from "./mocks";
import { DLQ_ALARM_LINK, POLICY_AUDIT } from "./observability-spec";
import { OperationEvents, OperationEventsDlq } from "./operations";
import { Scheduler, worldJanitor } from "./scheduler";
import { OriginVerifyKey, SessionTokenKey } from "./secrets";
import { storageLinks } from "./storage";
import { router } from "./web";
import { EDGE_BUDGETS, LAMBDA_ROUTES, type EdgeFunction } from "./web-spec";

/** Lambda entries; each file belongs to the WP that writes the code (docs/build-plan.md §2). */
export const BFF_HANDLERS = {
  Bff: "packages/bff/src/routers/handler.handler", // WP-33
  PublicWeb: "packages/bff/src/public-web/handler.handler", // WP-38
  QaDriver: "packages/bff/src/handlers/qa-driver.handler", // WP-37
  PolicyAudit: "packages/bff/src/handlers/policy-audit.handler", // WP-33
} as const satisfies Partial<Record<LambdaName, string>>;

/** Fixed name the bootstrap's `qa-runner` role is fenced to (docs/architecture.md §1, ci-role.yaml). */
export function qaDriverFunctionName(app: string, stage: string): string {
  return `${app}-${stage}-qa-driver`;
}

/** A scenario step drives the world and waits for it to settle (docs/test-plan.md §4): up to 15 minutes. */
export const QA_DRIVER = { timeoutSeconds: 900, memoryMb: 1024 } as const;

/** Function URL behind the Router: path, CloudFront read timeout, budget and reserved concurrency (web-spec.ts). */
function edgeArgs(fn: EdgeFunction) {
  const budget = EDGE_BUDGETS[fn];
  return {
    timeout: `${budget.timeoutSeconds} seconds` as const,
    memory: `${budget.memoryMb} MB` as const,
    concurrency: { reserved: budget.reservedConcurrency },
    url: {
      authorization: "iam" as const,
      cors: false,
      router: { instance: router, path: LAMBDA_ROUTES[fn], readTimeout: `${budget.routerReadTimeoutSeconds} seconds` as const },
    },
  };
}

// ---- PolicyAudit ------------------------------------------------------------------------------------

export const policyAudit = new sst.aws.Function("PolicyAudit", {
  description: "Daily and on-demand re-evaluation of every sent message against its ALLOW decision and the contact policy.",
  handler: BFF_HANDLERS.PolicyAudit,
  timeout: `${POLICY_AUDIT.timeoutSeconds} seconds`,
  memory: `${POLICY_AUDIT.memoryMb} MB`,
  link: storageLinks("PolicyAudit"),
});

export const policyAuditDaily = new sst.aws.Cron("PolicyAuditDaily", {
  function: policyAudit.arn,
  schedule: POLICY_AUDIT.schedule,
  event: POLICY_AUDIT.event,
  enabled: POLICY_AUDIT.enabled,
});

// ---- Bff ----------------------------------------------------------------------------------------------

/** Leads, SignupDispatch, LeadNotice, OriginVerifyKey and the fenced Cognito and Runtime statements (infra/leads.ts). */
const bffSignup = signupGrants("Bff");

export const bff = new sst.aws.Function("Bff", {
  description: "Console BFF: tRPC behind the Router at /api (OAC, X-Origin-Verify), public signup, guest worlds, phone simulator.",
  handler: BFF_HANDLERS.Bff,
  ...edgeArgs("bff"),
  link: [
    // Its tables, Documents (download links), Media (simulator uploads) and Seed (world templates).
    ...storageLinks("Bff"),
    // PlatformMock (MOCK_PLATFORM) and Platform's name; the table only by its statement below.
    ...mockLinks("Bff"),
    Auth, // id token verification, TOTP status
    ChannelModes, // the simulator answers only in `simulated`
    SessionTokenKey, // HKDF subkeys (session, hashes, thread tags, signup)
    Scheduler, // TIMERS of WORLDS: a reset deletes the world's schedules
    Agent, // MEMORY_ADMIN of WORLDS: first pass of the Memory purge
    OperationEvents, // OUTBOUND_SEND and clock work, sqs:SendMessage only
    inboundWhatsApp, // the phone simulator's signed envelope
    simMail, // SIM_REPLY timers a clock move dispatches (timers/stage.ts)
    worldJanitor, // MEMORY_PURGE and GUEST_CREATE, asynchronously
    ...bffSignup.link,
  ],
  permissions: [...mockPermissions("Bff"), ...bffSignup.permissions],
});

/** Resource side of MOCK_PLATFORM (infra/mocks.ts). */
export const bffMockGrants = grantMockInvoke("Bff", bff);

// ---- PublicWeb ----------------------------------------------------------------------------------------

export const publicWeb = new sst.aws.Function("PublicWeb", {
  description: "Importer's upload page /u/<token>: no login, link token only, presigned POST to Uploads (OAC, X-Origin-Verify).",
  handler: BFF_HANDLERS.PublicWeb,
  ...edgeArgs("publicWeb"),
  // Runtime (links), AuditLog (accesses), Uploads (presigned POST); the origin check's secret.
  link: [...storageLinks("PublicWeb"), OriginVerifyKey],
});

/** The two Lambdas behind the Router, by route. */
export const edgeFunctions: Readonly<Record<EdgeFunction, sst.aws.Function>> = { bff, publicWeb };

// ---- QaDriver -----------------------------------------------------------------------------------------

/** Leads (SC-26 only), the simulated mailboxes' raw MIME and the SC-26 Cognito actions (infra/leads.ts). */
const qaSignup = signupGrants("QaDriver");

export const qaDriver = new sst.aws.Function("QaDriver", {
  name: qaDriverFunctionName($app.name, $app.stage),
  description: "Scenario driver of the stage, invoked only by the qa-runner role; fenced to QA worlds and the guest-test world.",
  handler: BFF_HANDLERS.QaDriver,
  timeout: `${QA_DRIVER.timeoutSeconds} seconds`,
  memory: `${QA_DRIVER.memoryMb} MB`,
  link: links(
    [
      // Its tables, Documents, Uploads, Media and Seed; ReaderCatalog (faults) and both mocks.
      ...storageLinks("QaDriver"),
      ...mockLinks("QaDriver"),
      // EmailSenderQa (`email.inject`: qainject-*@sim / qa-*@sim, set …-sim-poc) and the `poc/ops/` MIME.
      ...emailLinks("QaDriver"),
      Auth,
      ChannelModes,
      SessionTokenKey,
      Scheduler,
      Agent, // purge and `memory.inspect`
      GuardrailG1, // `guardrail.probe`
      OperationEvents,
      OperationEventsDlq, // `dlq.find`, `dlq.delete`: Receive, Delete, GetQueueAttributes on the DLQ only
      inboundEmail, // `email.redeliver`
      simMail, // `supplier.sendNow`
      inboundWhatsApp, // `wa.inbound`, the same entry the simulator uses
      policyAudit, // `policyAudit.run`
      worldJanitor, // MEMORY_PURGE and SC-26's `lead.purge`
      ...qaSignup.link,
    ],
    // `alarm.history`: DescribeAlarmHistory on the DLQ alarm only (infra/observability.ts imports this module).
    lateLinks("bff", "observability", () => import("./observability"), [DLQ_ALARM_LINK]),
  ),
  permissions: [...mockPermissions("QaDriver"), ...qaSignup.permissions],
});

/** Only the bootstrap's qa-runner role may invoke the QaDriver (ADR-0005). */
export const qaDriverInvokeByQaRunner = new aws.lambda.Permission("QaDriverInvokeByQaRunner", {
  action: "lambda:InvokeFunction",
  function: qaDriver.name,
  principal: qaRunnerRoleArn,
});

/** Resource side of MOCK_READER and MOCK_PLATFORM (infra/mocks.ts). */
export const qaDriverMockGrants = grantMockInvoke("QaDriver", qaDriver);
