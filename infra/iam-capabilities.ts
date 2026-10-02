// Least-privilege capabilities per Lambda (docs/architecture.md §14), as plain data. No SST or Pulumi
// dependency: every infra module that creates a Function builds its `link` and its
// `sst.aws.permission` statements from the entry of that function here, and
// infra/iam-capabilities.test.ts derives the expected actions and compares them with what the
// modules generate. A permission that is not in this file is drift, and the test fails.
//
// Tables and buckets are granted through `link` (SST derives the DynamoDB and S3 actions from the
// linked component), so they are listed as data access, not as raw actions. The actions listed
// under `actions` are the ones a module must add with `sst.aws.permission`.

export type TableName =
  | "Firms"
  | "Parties"
  | "Operations"
  | "Conversations"
  | "AuditLog"
  | "Reference"
  | "Runtime"
  | "LegajoMetrics"
  | "ReaderCatalog"
  | "Platform"
  | "Leads";

export type BucketName = "Documents" | "Uploads" | "Media" | "Seed" | "InboundMail";

export type Access = "read" | "write";

export type CapabilityName =
  | "TIMERS"
  | "SEND_EMAIL"
  | "SEND_WHATSAPP"
  | "PIPELINE"
  | "MOCK_READER"
  | "MOCK_PLATFORM"
  | "MEMORY_ADMIN"
  | "WORLDS"
  | "LEADS"
  | "SIGNUP_ADMIN"
  | "SIGNUP_DISPATCH"
  | "LEAD_NOTICE"
  | "MAIL_STATUS"
  | "GUEST_CLEANUP"
  | "QA_SIGNUP";

export interface Capability {
  readonly actions: readonly string[];
  /** Other capabilities this one includes. */
  readonly includes?: readonly CapabilityName[];
  readonly tables?: Readonly<Partial<Record<TableName, Access>>>;
  readonly buckets?: Readonly<Partial<Record<BucketName, Access>>>;
  /** Resource or condition, as docs/architecture.md §14 states it. */
  readonly fence: string;
}

const WORLD_TABLES = {
  Platform: "write",
  Firms: "write",
  Parties: "write",
  Operations: "write",
  Conversations: "write",
  AuditLog: "write",
  LegajoMetrics: "write",
  Runtime: "write",
} as const satisfies Partial<Record<TableName, Access>>;

export const CAPABILITIES: Readonly<Record<CapabilityName, Capability>> = {
  TIMERS: {
    actions: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule", "iam:PassRole"],
    fence: "schedule/aws-cds-hackathon-poc-legajo-poc-schedules/*; PassRole only of the Scheduler invocation role, iam:PassedToService = scheduler.amazonaws.com",
  },
  SEND_EMAIL: {
    actions: ["ses:SendEmail"],
    fence: "identity legajo.demo.craftech.io + configuration set …-email-poc; ses:FromAddress op-*@ / avisos@; ses:Recipients *@sim.legajo.demo.craftech.io, *@simulator.amazonses.com + SeedOverrides.demoRecipients",
  },
  SEND_WHATSAPP: {
    actions: ["social-messaging:SendWhatsAppMessage"],
    fence: "phone-number-id of the secret; statement omitted while it is not-connected",
  },
  PIPELINE: {
    actions: ["bedrock:ApplyGuardrail"],
    includes: ["SEND_EMAIL", "SEND_WHATSAPP", "TIMERS"],
    fence: "G2 guardrail",
  },
  MOCK_READER: {
    actions: ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"],
    fence: "ARN of ReaderMock; InvokeFunctionUrl with lambda:FunctionUrlAuthType = AWS_IAM",
  },
  MOCK_PLATFORM: {
    actions: ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"],
    fence: "ARN of PlatformMock; InvokeFunctionUrl with lambda:FunctionUrlAuthType = AWS_IAM",
  },
  MEMORY_ADMIN: {
    actions: [
      "bedrock-agentcore:ListEvents",
      "bedrock-agentcore:DeleteEvent",
      "bedrock-agentcore:ListMemoryRecords",
      "bedrock-agentcore:DeleteMemoryRecord",
      "bedrock-agentcore:RetrieveMemoryRecords",
    ],
    fence: "Memory of the stage",
  },
  WORLDS: {
    actions: [],
    includes: ["TIMERS", "MEMORY_ADMIN"],
    tables: WORLD_TABLES,
    buckets: { Seed: "read", Media: "write" },
    fence: "Platform with ForAllValues:StringLike dynamodb:LeadingKeys per role (WORLDS_LEADING_KEYS); Seed pdfs/* and worlds/*; Media sim/*",
  },
  // ---- Public signup and leads (ADR-0015, docs/architecture.md §14) ----
  LEADS: {
    actions: [],
    tables: { Leads: "write" },
    fence: "Leads only through the name-only Linkable `Leads` plus the role's own statement (infra/leads-spec.ts LEADS_ACCESS); never linked whole",
  },
  SIGNUP_ADMIN: {
    actions: ["cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser", "cognito-idp:AdminAddUserToGroup"],
    fence: "the app's user pool ARN; AdminAddUserToGroup only with the literal group GUEST and only on a user with no group (fenced in code and test)",
  },
  SIGNUP_DISPATCH: {
    actions: ["lambda:InvokeFunction"],
    fence: "InvokeFunction only of SignupDispatch, asynchronously (InvocationType Event)",
  },
  LEAD_NOTICE: {
    actions: ["lambda:InvokeFunction"],
    fence: "InvokeFunction only of LeadNotice, asynchronously (InvocationType Event)",
  },
  MAIL_STATUS: {
    actions: [],
    tables: { Runtime: "write" },
    fence: "Runtime PutItem/UpdateItem of MAILSTATUS#, RL#MAILBAD# and MAILBREAKER; subkey lead-email of SessionTokenKey; never Leads",
  },
  GUEST_CLEANUP: {
    actions: ["cognito-idp:ListUsers", "cognito-idp:AdminDeleteUser", "s3:DeleteObject", "s3:ListBucket"],
    fence:
      "the app's user pool ARN, AdminDeleteUser only of UNCONFIRMED users without groups or of a lead being deleted (fenced in code); DeleteObject and ListBucket only under guest/* of Documents and Media, uploads/* of Uploads and poc/ops/*, poc/sim/* of the mail bucket (infra/leads-spec.ts GUEST_OBJECT_PREFIXES)",
  },
  QA_SIGNUP: {
    actions: ["cognito-idp:AdminGetUser", "cognito-idp:AdminDeleteUser", "cognito-idp:ListUsers", "lambda:InvokeFunction", "s3:ListBucket"],
    tables: { Leads: "write" },
    buckets: { InboundMail: "read" },
    fence:
      "signup.readCode, lead.inspect and lead.purge of SC-26 (docs/test-plan.md §4.1): GetObject and ListBucket of poc/sim/* of the mail bucket; Leads GetItem, Query, DeleteItem and PutItem; the app's user pool ARN; InvokeFunction of WorldJanitor; only the qa-signup-<runId>-* mailboxes of its own run (fenced in code)",
  },
};

/** `dynamodb:LeadingKeys` of `Platform` per role that holds `WORLDS` (docs/architecture.md §14). */
export const WORLDS_LEADING_KEYS = {
  Bff: ["POP#firm-delta#*", "POP#firm-norte#*", "POP#firm-guest-*"],
  WorldJanitor: ["POP#firm-guest-*"],
  QaDriver: ["POP#firm-qa#*", "POP#firm-sim#*", "POP#firm-guest-test#*"],
} as const;

export type WorldsRole = keyof typeof WORLDS_LEADING_KEYS;

export interface LambdaCapabilities {
  readonly capabilities: readonly CapabilityName[];
  readonly tables?: Readonly<Partial<Record<TableName, Access>>>;
  readonly buckets?: Readonly<Partial<Record<BucketName, Access>>>;
  /** Actions beyond the capabilities and the linked data, each fenced as `fence` says. */
  readonly actions?: readonly string[];
  readonly fence?: string;
}

export const LAMBDA_CAPABILITIES = {
  OperationWorker: {
    capabilities: ["PIPELINE", "MOCK_READER"],
    tables: { Operations: "write", Parties: "write", Conversations: "write", Runtime: "write", AuditLog: "write", Firms: "read", Reference: "read", LegajoMetrics: "write" },
    buckets: { Documents: "write", Uploads: "read", Media: "read", InboundMail: "read" },
    actions: ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime", "sqs:SendMessage", "sqs:ChangeMessageVisibility"],
    fence: "ChangeMessageVisibility only on OperationEvents.fifo; ApplyGuardrail also G1 (pre-filter)",
  },
  ToolOperations: {
    capabilities: [],
    tables: { Operations: "write", Parties: "write", Firms: "read", Reference: "read", Runtime: "write", AuditLog: "write" },
  },
  ToolDocuments: {
    capabilities: ["MOCK_READER"],
    tables: { Operations: "write", Runtime: "write", AuditLog: "write" },
    buckets: { Documents: "read" },
  },
  ToolMessaging: {
    capabilities: ["PIPELINE"],
    tables: { Operations: "write", Parties: "write", Conversations: "write", Runtime: "write", AuditLog: "write", Reference: "read" },
  },
  ToolFollowups: {
    capabilities: ["TIMERS"],
    tables: { Operations: "write", Firms: "read", Runtime: "write", AuditLog: "write" },
  },
  ToolHandoff: {
    capabilities: ["PIPELINE"],
    tables: { Operations: "write", Firms: "read", Conversations: "write", Runtime: "write", AuditLog: "write" },
  },
  InboundWhatsApp: {
    capabilities: ["SEND_WHATSAPP"],
    tables: { Parties: "write", Runtime: "write", Conversations: "write", Operations: "write", AuditLog: "write" },
    buckets: { Media: "write" },
    actions: ["social-messaging:GetWhatsAppMessageMedia", "sqs:SendMessage"],
  },
  InboundEmail: {
    capabilities: [],
    tables: { Operations: "write", Parties: "write", Conversations: "write", Runtime: "write", AuditLog: "write" },
    buckets: { InboundMail: "read", Documents: "write" },
    actions: ["sqs:SendMessage"],
    fence: "InboundMail poc/ops/*; Documents quarantine/*",
  },
  SimMail: {
    capabilities: ["TIMERS"],
    tables: { Conversations: "write", Operations: "read", Parties: "read", Runtime: "write", AuditLog: "write" },
    buckets: { InboundMail: "read", Seed: "read" },
    actions: ["ses:SendEmail"],
    fence: "ses:FromAddress *@sim.legajo.demo.craftech.io; ses:Recipients op-*@legajo.demo.craftech.io; configuration set …-sim-poc; InboundMail poc/sim/*",
  },
  ChannelEvents: {
    capabilities: ["MAIL_STATUS"],
    tables: { Conversations: "write", Runtime: "write" },
    actions: ["sqs:SendMessage"],
    fence: "no Leads: the bounce state of a recipient lives in Runtime/MAILSTATUS#",
  },
  FeedEvents: {
    capabilities: [],
    tables: { Operations: "write", Runtime: "write", AuditLog: "write" },
    actions: ["sqs:SendMessage"],
  },
  DocumentIntake: {
    capabilities: [],
    tables: { Runtime: "write", Operations: "read", AuditLog: "write" },
    buckets: { Uploads: "read", Media: "read" },
    actions: ["s3:GetObjectTagging", "sqs:SendMessage"],
  },
  PublicWeb: {
    capabilities: [],
    tables: { Runtime: "write", AuditLog: "write" },
    buckets: { Uploads: "write" },
    fence: "secret OriginVerifyKey; Function URL AWS_IAM, only cloudfront.amazonaws.com with the distribution as SourceArn (OAC)",
  },
  ScheduleDispatch: {
    capabilities: [],
    tables: { Operations: "read" },
    actions: ["sqs:SendMessage", "lambda:InvokeFunction"],
    fence: "InvokeFunction only of SimMail",
  },
  Bff: {
    capabilities: ["MOCK_PLATFORM", "WORLDS", "LEADS", "SIGNUP_ADMIN", "SIGNUP_DISPATCH", "LEAD_NOTICE"],
    tables: { Firms: "write", Parties: "write", Operations: "write", Conversations: "write", AuditLog: "write", Runtime: "write", LegajoMetrics: "write", Reference: "read" },
    buckets: { Documents: "read", Media: "write" },
    actions: ["sqs:SendMessage", "lambda:InvokeFunction"],
    fence: "InvokeFunction only of InboundWhatsApp, WorldJanitor, SignupDispatch and LeadNotice; no SES, no EUM Social, no Guardrails; Function URL AWS_IAM, only cloudfront.amazonaws.com with the distribution as SourceArn (OAC)",
  },
  SignupDispatch: {
    capabilities: [],
    tables: { Leads: "write", Runtime: "write" },
    actions: ["cognito-idp:ListUsers", "cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser", "cognito-idp:AdminDeleteUser"],
    fence:
      "Leads GetItem, UpdateItem and DeleteItem of SIGNUP# only (never writes a lead); Runtime GetItem of MAILSTATUS# and MAILBREAKER, UpdateItem of RL#; the app's user pool ARN, AdminDeleteUser only of UNCONFIRMED users without groups (fenced in code); no InvokeFunction of LeadNotice; invoked asynchronously only by Bff, no retries, reserved concurrency 2",
  },
  WorldJanitor: {
    capabilities: ["WORLDS", "LEADS", "SIGNUP_ADMIN", "LEAD_NOTICE", "GUEST_CLEANUP"],
  },
  AuthPreToken: {
    capabilities: [],
    tables: { Firms: "read" },
    fence: "Firms BROKER# rows and GSI1; invoked only by cognito-idp.amazonaws.com with the pool as SourceArn",
  },
  AuthPreSignUp: {
    capabilities: [],
    fence: "no table: HMAC of the signup ticket with the subkey signup-ticket of SessionTokenKey; invoked only by cognito-idp.amazonaws.com with the pool as SourceArn",
  },
  AuthCustomMessage: {
    capabilities: [],
    tables: { Runtime: "write" },
    fence: "Runtime UpdateItem of RL#MAIL…, GetItem of MAILSTATUS# and MAILBREAKER; subkeys rate and lead-email of SessionTokenKey; no Leads; invoked only by cognito-idp.amazonaws.com with the pool as SourceArn",
  },
  LeadNotice: {
    capabilities: [],
    tables: { Leads: "write" },
    actions: ["ses:SendEmail"],
    fence:
      "Leads GetItem and UpdateItem of noticeStatus; secret LeadNoticeTo; ses:FromAddress avisos@legajo.demo.craftech.io, ses:Recipients *@craftech.io, configuration set …-email-poc; no Runtime, no Conversations (LEAD_NOTICE is a profile without a clock); invoked asynchronously only by Bff and WorldJanitor",
  },
  PolicyAudit: {
    capabilities: [],
    tables: { Conversations: "read", AuditLog: "write", Operations: "read", Parties: "read", Firms: "read", Reference: "read" },
  },
  ReaderMock: {
    capabilities: [],
    tables: { ReaderCatalog: "write" },
    fence: "downloads only presigned URLs of Documents (no IAM permission of its own)",
  },
  PlatformMock: {
    capabilities: [],
    tables: { Platform: "write" },
    actions: ["events:PutEvents"],
    fence: "PutEvents only to the Feeds bus",
  },
  QaDriver: {
    capabilities: ["MOCK_PLATFORM", "MOCK_READER", "WORLDS", "QA_SIGNUP"],
    tables: {
      Firms: "write",
      Parties: "write",
      Operations: "write",
      Conversations: "write",
      AuditLog: "write",
      Runtime: "write",
      LegajoMetrics: "write",
      Reference: "read",
      ReaderCatalog: "write",
    },
    buckets: { Documents: "write", Uploads: "write", Media: "write", InboundMail: "read" },
    actions: [
      "ses:SendEmail",
      "lambda:InvokeFunction",
      "s3:DeleteObject",
      "scheduler:DeleteSchedule",
      "bedrock:ApplyGuardrail",
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "cloudwatch:DescribeAlarmHistory",
    ],
    fence:
      "ses:FromAddress qainject-*@sim / qa-*@sim, ses:Recipients op-*@ / qa-*@sim, configuration set …-sim-poc; InvokeFunction of InboundEmail, SimMail and PolicyAudit; DeleteObject only qa/*; DeleteSchedule only tm-q-* and tm-g-*; sqs Receive/Delete/GetQueueAttributes only on OperationEventsDlq.fifo; DescribeAlarmHistory only on the DLQ alarm",
  },
} as const satisfies Record<string, LambdaCapabilities>;

export type LambdaName = keyof typeof LAMBDA_CAPABILITIES;

/** SQS actions of the QaDriver that only the DLQ may receive (`dlq.find`, `dlq.delete`). */
export const QA_DRIVER_DLQ_ONLY_ACTIONS = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"] as const;

/** Every capability a function holds, with the ones they include, without duplicates. */
export function resolveCapabilities(names: readonly CapabilityName[]): CapabilityName[] {
  const seen = new Set<CapabilityName>();
  const visit = (name: CapabilityName): void => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const included of CAPABILITIES[name].includes ?? []) visit(included);
  };
  for (const name of names) visit(name);
  return [...seen].sort();
}

/** Raw IAM actions a function must receive through `sst.aws.permission` (data access goes by `link`). */
export function expectedActions(fn: LambdaName): string[] {
  const entry: LambdaCapabilities = LAMBDA_CAPABILITIES[fn];
  const actions = new Set<string>(entry.actions ?? []);
  for (const capability of resolveCapabilities(entry.capabilities)) for (const action of CAPABILITIES[capability].actions) actions.add(action);
  return [...actions].sort();
}

/** Tables a function reaches, capabilities included; `write` wins over `read`. */
export function expectedTables(fn: LambdaName): Partial<Record<TableName, Access>> {
  const entry: LambdaCapabilities = LAMBDA_CAPABILITIES[fn];
  const merged: Partial<Record<TableName, Access>> = {};
  const add = (tables: Readonly<Partial<Record<TableName, Access>>> | undefined): void => {
    for (const [table, access] of Object.entries(tables ?? {}) as Array<[TableName, Access]>) {
      if (merged[table] !== "write") merged[table] = access;
    }
  };
  add(entry.tables);
  for (const capability of resolveCapabilities(entry.capabilities)) add(CAPABILITIES[capability].tables);
  return merged;
}

/** Actions a module generated that the capabilities do not allow, and allowed ones it did not generate. */
export function actionDrift(fn: LambdaName, generated: readonly string[]): { extra: string[]; missing: string[] } {
  const expected = new Set(expectedActions(fn));
  const actual = new Set(generated);
  return {
    extra: [...actual].filter((action) => !expected.has(action)).sort(),
    missing: [...expected].filter((action) => !actual.has(action)).sort(),
  };
}
