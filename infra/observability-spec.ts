// Observability of the app as plain data and pure functions (docs/architecture.md §12, ADR-0015 §9,
// docs/build-plan.md WP-32). No SST or Pulumi dependency: infra/observability.ts and infra/bff.ts
// build the resources from this file, and infra/observability-spec.test.ts checks every value against
// the docs, the code that writes the log lines and the modules that hold the other numbers of §12.
//
// Metrics. Every metric of `LegajoAgent/*` is a CloudWatch Logs metric filter over the log group SST
// creates for a function (`fn.nodes.logGroup`), one filter per emitting function. The code writes one
// JSON line per occurrence with a `metric` field (packages/bff/src/channels/adapter.ts `countMetric`,
// written raw to stdout by packages/bff/src/lib/log.ts, so each line is a JSON log event); ToolErrors
// counts every error-level line of the tool Lambdas instead. A metric with an alarm carries no
// dimension (the alarm watches the plain metric); a metric "per reason" or "per kind" carries one.
// A filter whose emitter is not written yet (`pendingIn`) costs nothing: custom metrics bill only
// for the hours they receive data.
//
// Alarms, the project budget, the reserved concurrency and the daily PolicyAudit of §12 live here too.

import type { LambdaName } from "./iam-capabilities";

export const METRIC_NAMESPACE = "LegajoAgent";

export type MetricUnit = "Count" | "Milliseconds" | "None";

export interface MetricSpec {
  readonly name: string;
  /** Functions whose log group carries the line: one metric filter per log group. */
  readonly emitters: readonly LambdaName[];
  /** Defaults to `{ $.metric = "<name>" }`. */
  readonly pattern?: string;
  /** JSON field holding the value; defaults to one per line. */
  readonly value?: string;
  readonly unit: MetricUnit;
  /** Dimension name → JSON field of the line (CloudWatch accepts at most 3). */
  readonly dimensions?: Readonly<Record<string, string>>;
  /** File of packages/bff that names the metric today. */
  readonly source?: string;
  /** Work package that writes the line, while no code does yet. */
  readonly pendingIn?: string;
}

const TOOLS = ["ToolOperations", "ToolDocuments", "ToolMessaging", "ToolFollowups", "ToolHandoff"] as const satisfies readonly LambdaName[];
/** Holders of PIPELINE (iam-capabilities.ts): every send goes through the outbound pipeline there. */
const PIPELINE_RUNNERS = ["OperationWorker", "ToolMessaging", "ToolHandoff"] as const satisfies readonly LambdaName[];
/** `consumeQuota` of worlds/guest-quotas.ts: console procedures, upload page, and the pipeline (`CP-WORLD-QUOTA`, worker turns). */
const QUOTA_RUNNERS = ["Bff", "PublicWeb", ...PIPELINE_RUNNERS] as const satisfies readonly LambdaName[];

const BFF = "packages/bff/src";

/** Metrics of docs/architecture.md §12 and ADR-0015 §9. */
export const DOCUMENTED_METRICS: readonly MetricSpec[] = [
  { name: "TurnLatency", emitters: ["OperationWorker"], value: "$.latencyMs", unit: "Milliseconds", source: `${BFF}/turns/record.ts` },
  { name: "TurnErrors", emitters: ["OperationWorker"], unit: "Count", source: `${BFF}/turns/record.ts` },
  { name: "ToolErrors", emitters: TOOLS, pattern: '{ $.level = "error" }', unit: "Count", source: `${BFF}/agent-tools/common/handler.ts` },
  { name: "PolicyDenials", emitters: PIPELINE_RUNNERS, unit: "Count", source: `${BFF}/outbound/pipeline.ts` },
  { name: "PolicyViolations", emitters: ["PolicyAudit", "QaDriver"], unit: "Count", source: `${BFF}/policy-audit/audit.ts` },
  // G1 and the Harness, both in the worker's turn (worker/guardrail-block.ts); a G2 refusal of the pipeline is audited with rule G2 instead.
  { name: "GuardrailBlocks", emitters: ["OperationWorker"], unit: "Count", dimensions: { Origin: "$.origin", Source: "$.source" }, source: `${BFF}/worker/guardrail-block.ts` },
  { name: "MemoryPurgeIncomplete", emitters: ["WorldJanitor"], unit: "Count", source: `${BFF}/worlds/memory-purge.ts` },
  { name: "TurnCapHits", emitters: ["OperationWorker"], unit: "Count", source: `${BFF}/turns/turn.ts` },
  { name: "ReaderErrors", emitters: ["OperationWorker", "ToolDocuments"], unit: "Count", source: `${BFF}/reader/client.ts` },
  { name: "OutboundSent", emitters: PIPELINE_RUNNERS, unit: "Count", dimensions: { Channel: "$.channel" }, source: `${BFF}/channels/email/config.ts` },
  { name: "CostPerDossier", emitters: ["Bff"], value: "$.costUsd", unit: "None", source: `${BFF}/routers/dossier.ts` },
  { name: "UploadLinkInvalid", emitters: ["PublicWeb"], unit: "Count", source: `${BFF}/public-web/audit.ts` },
  { name: "MalwareFindings", emitters: ["DocumentIntake"], unit: "Count", source: `${BFF}/handlers/document-intake.ts` },
  { name: "SimUntrusted", emitters: ["SimMail"], unit: "Count", source: `${BFF}/sim-mail/config.ts` },
  // The public signup and the guest worlds (ADR-0015 §9).
  { name: "SignupStarted", emitters: ["Bff"], unit: "Count", source: `${BFF}/signup/dispatch.ts` },
  { name: "SignupConfirmed", emitters: ["Bff", "WorldJanitor"], unit: "Count", source: `${BFF}/signup/dispatch.ts` },
  { name: "SignupRejected", emitters: ["Bff", "SignupDispatch", "AuthPreSignUp"], unit: "Count", dimensions: { Reason: "$.reason" }, source: `${BFF}/signup/dispatch.ts` },
  { name: "SignupMxUnknown", emitters: ["SignupDispatch"], unit: "Count", source: `${BFF}/signup/dispatch.ts` },
  { name: "SignupDispatchFailed", emitters: ["Bff", "SignupDispatch"], unit: "Count", source: `${BFF}/signup/dispatch.ts` },
  { name: "AccountMailBlocked", emitters: ["AuthCustomMessage"], unit: "Count", source: `${BFF}/auth-triggers/custom-message.ts` },
  { name: "AccountMailBreakerOpen", emitters: ["ChannelEvents"], unit: "Count", source: `${BFF}/channels/email/mail-status.ts` },
  { name: "GuestWorldCapacity", emitters: ["Bff"], unit: "Count", source: `${BFF}/worlds/guest-worlds.ts` },
  { name: "GuestWorldFailed", emitters: ["WorldJanitor"], unit: "Count", source: `${BFF}/worlds/guest-worlds.ts` },
  { name: "QuotaHits", emitters: QUOTA_RUNNERS, unit: "Count", dimensions: { Kind: "$.kind" }, source: `${BFF}/worlds/guest-quotas.ts` },
  { name: "GuestBudgetHits", emitters: QUOTA_RUNNERS, unit: "Count", source: `${BFF}/worlds/guest-quotas.ts` },
  { name: "LeadNoticeFailed", emitters: ["LeadNotice"], unit: "Count", source: `${BFF}/leads/notice/notice.ts` },
];

/**
 * Metrics the channel code already counts beyond the list of §12 (their constants say a filter of
 * this module counts them): the thread address check of inbound email, the bounce state of the
 * account emails and the WhatsApp adapter. §12 lists them in their own line.
 */
export const CODE_METRICS: readonly MetricSpec[] = [
  { name: "ThreadAddressInvalid", emitters: ["InboundEmail"], unit: "Count", source: `${BFF}/channels/email/config.ts` },
  { name: "AccountMailStatusMarked", emitters: ["ChannelEvents"], unit: "Count", source: `${BFF}/channels/email/mail-status.ts` },
  { name: "WhatsAppEnvelopeRejected", emitters: ["InboundWhatsApp"], unit: "Count", source: `${BFF}/channels/whatsapp/inbound.ts` },
  { name: "WhatsAppUnknownSender", emitters: ["InboundWhatsApp"], unit: "Count", source: `${BFF}/channels/whatsapp/inbound-senders.ts` },
  { name: "WhatsAppIdentityAmbiguous", emitters: ["InboundWhatsApp"], unit: "Count", source: `${BFF}/channels/whatsapp/inbound-senders.ts` },
  { name: "WhatsAppRateLimited", emitters: ["InboundWhatsApp"], unit: "Count", source: `${BFF}/channels/whatsapp/inbound-senders.ts` },
  { name: "WhatsAppSendFailed", emitters: ["InboundWhatsApp"], unit: "Count", source: `${BFF}/channels/whatsapp/events.ts` },
  { name: "WhatsAppPricingCategory", emitters: ["InboundWhatsApp"], unit: "Count", source: `${BFF}/channels/whatsapp/events.ts` },
  { name: "WhatsAppStatusUnknownMessage", emitters: ["InboundWhatsApp"], unit: "Count", source: `${BFF}/channels/whatsapp/events.ts` },
];

export const METRICS: readonly MetricSpec[] = [...DOCUMENTED_METRICS, ...CODE_METRICS];

/** Filter pattern of a metric. */
export function metricPattern(spec: MetricSpec): string {
  return spec.pattern ?? `{ $.metric = "${spec.name}" }`;
}

export interface MetricFilterSpec {
  /** Pulumi name of the filter: `Metric<metric><emitter>`. */
  readonly logicalName: string;
  readonly emitter: LambdaName;
  readonly metric: string;
  readonly pattern: string;
  readonly value: string;
  readonly unit: MetricUnit;
  readonly dimensions?: Readonly<Record<string, string>>;
}

/** One filter per metric and emitting function. */
export function metricFilterSpecs(metrics: readonly MetricSpec[] = METRICS): MetricFilterSpec[] {
  return metrics.flatMap((spec) =>
    spec.emitters.map((emitter) => ({
      logicalName: `Metric${spec.name}${emitter}`,
      emitter,
      metric: spec.name,
      pattern: metricPattern(spec),
      value: spec.value ?? "1",
      unit: spec.unit,
      ...(spec.dimensions === undefined ? {} : { dimensions: spec.dimensions }),
    })),
  );
}

// ---- Alarms ---------------------------------------------------------------------------------------

/** Account bounce rate of SES that raises the alarm: SES reviews an account at 5 % and may pause it at 10 %. */
export const SES_BOUNCE_RATE_ALARM = 0.02;

export type AlarmKey =
  | "operation-events-dlq"
  | "policy-violations"
  | "turn-errors"
  | "turn-cap-hits"
  | "reader-errors"
  | "malware-findings"
  | "ses-bounce-rate"
  | "account-mail-blocked"
  | "account-mail-breaker-open"
  | "signup-dispatch-failed"
  | "guest-budget-hits"
  | "lead-notice-failed";

/**
 * What an alarm watches: a metric of `LegajoAgent` (Sum), the messages of OperationEventsDlq.fifo
 * (visible plus in flight, Maximum, so a message `dlq.find` is reading still counts), or the account's
 * SES bounce rate (no dimension: SES keeps one reputation per account and region).
 */
export type AlarmSource = { readonly kind: "metric"; readonly metric: string } | { readonly kind: "dlq" } | { readonly kind: "sesBounceRate" };

export interface AlarmSpec {
  readonly key: AlarmKey;
  readonly description: string;
  readonly source: AlarmSource;
  readonly comparison: "GreaterThanThreshold" | "GreaterThanOrEqualToThreshold";
  readonly threshold: number;
  readonly periodSeconds: number;
  readonly evaluationPeriods: number;
}

const ONE_MINUTE = 60;
const FIVE_MINUTES = 300;
const FIFTEEN_MINUTES = 900;
const ONE_HOUR = 3_600;

const above = (key: AlarmKey, metric: string, threshold: number, periodSeconds: number, description: string): AlarmSpec => ({
  key,
  description,
  source: { kind: "metric", metric },
  comparison: "GreaterThanThreshold",
  threshold,
  periodSeconds,
  evaluationPeriods: 1,
});

/** The alarms of docs/architecture.md §12 (and ADR-0015 §9). Missing data is never a breach. */
export const ALARMS: readonly AlarmSpec[] = [
  {
    key: "operation-events-dlq",
    description: "An event of an operation failed twice and is waiting in OperationEventsDlq.fifo (docs/architecture.md §7).",
    source: { kind: "dlq" },
    comparison: "GreaterThanThreshold",
    threshold: 0,
    periodSeconds: ONE_MINUTE,
    evaluationPeriods: 1,
  },
  above("policy-violations", "PolicyViolations", 0, FIVE_MINUTES, "PolicyAudit found a sent message without its ALLOW decision or that the contact policy denies when re-evaluated."),
  above("turn-errors", "TurnErrors", 5, FIFTEEN_MINUTES, "More than 5 agent turns failed in 15 minutes."),
  above("turn-cap-hits", "TurnCapHits", 0, FIVE_MINUTES, "A firm reached its hard cap of agent turns per hour or per day."),
  above("reader-errors", "ReaderErrors", 0, FIFTEEN_MINUTES, "The external document reader failed or answered outside its contract."),
  above("malware-findings", "MalwareFindings", 0, FIVE_MINUTES, "GuardDuty found a threat in an uploaded file."),
  {
    key: "ses-bounce-rate",
    description: "SES bounce rate of the account at 2 %. SES reviews an account at 5 % and may pause sending at 10 %, for every project of this account.",
    source: { kind: "sesBounceRate" },
    comparison: "GreaterThanOrEqualToThreshold",
    threshold: SES_BOUNCE_RATE_ALARM,
    periodSeconds: ONE_HOUR,
    evaluationPeriods: 1,
  },
  above("account-mail-blocked", "AccountMailBlocked", 50, ONE_HOUR, "More than 50 account emails were cut by their quotas, the bounce state or the breaker in one hour."),
  above("account-mail-breaker-open", "AccountMailBreakerOpen", 0, FIVE_MINUTES, "The breaker of the account emails opened: only staff recovery and invitations go out."),
  above("signup-dispatch-failed", "SignupDispatchFailed", 5, ONE_HOUR, "More than 5 sign-ups could not reach Cognito in one hour."),
  above("guest-budget-hits", "GuestBudgetHits", 0, FIVE_MINUTES, "The daily budget of turns or emails shared by every public guest world ran out."),
  above("lead-notice-failed", "LeadNoticeFailed", 0, FIVE_MINUTES, "The internal notice of a new lead could not be sent."),
];

/** `<app>-<stage>-<key>`: fixed, so the QaDriver reads the history of the DLQ alarm by name. */
export function alarmName(app: string, stage: string, key: AlarmKey): string {
  return `${app}-${stage}-${key}`;
}

/** The DLQ alarm the QaDriver reads (`alarm.history`): `Resource.DlqAlarm.name` and only DescribeAlarmHistory on it. */
export const DLQ_ALARM_KEY: AlarmKey = "operation-events-dlq";
export const DLQ_ALARM_LINK = "DlqAlarm";
export const DLQ_ALARM_ACTIONS = ["cloudwatch:DescribeAlarmHistory"] as const;

/** SQS metrics the DLQ alarm adds up. */
export const DLQ_ALARM_METRICS = ["ApproximateNumberOfMessagesVisible", "ApproximateNumberOfMessagesNotVisible"] as const;

export interface MetricQuery<V> {
  readonly id: string;
  readonly returnData: boolean;
  readonly expression?: string;
  readonly label?: string;
  readonly metric?: { readonly namespace: string; readonly metricName: string; readonly stat: string; readonly period: number; readonly dimensions?: Readonly<Record<string, V>> };
}

/**
 * Queries of an alarm. Generic over the value of a dimension: infra/observability.ts passes the
 * queue's name as an Output, the test a plain string. Only the DLQ needs metric math.
 */
export function alarmQueries<V>(spec: AlarmSpec, dlqQueueName: V): Array<MetricQuery<V>> {
  const single = (namespace: string, metricName: string, stat: string): Array<MetricQuery<V>> => [
    { id: "m0", returnData: true, label: spec.key, metric: { namespace, metricName, stat, period: spec.periodSeconds } },
  ];
  switch (spec.source.kind) {
    case "metric":
      return single(METRIC_NAMESPACE, spec.source.metric, "Sum");
    case "sesBounceRate":
      return single("AWS/SES", "Reputation.BounceRate", "Maximum");
    case "dlq":
      return [
        ...DLQ_ALARM_METRICS.map((metricName, index) => ({
          id: `m${index}`,
          returnData: false,
          metric: { namespace: "AWS/SQS", metricName, stat: "Maximum", period: spec.periodSeconds, dimensions: { QueueName: dlqQueueName } },
        })),
        { id: "total", returnData: true, label: spec.key, expression: DLQ_ALARM_METRICS.map((_, index) => `FILL(m${index}, 0)`).join(" + ") },
      ];
  }
}

// ---- Project budget ---------------------------------------------------------------------------------

/**
 * Monthly budget of the project, filtered by the cost allocation tag `Project` (docs/architecture.md
 * §12 and §17 item 8), with notices at 50, 80 and 100 % of the actual cost to `SeedOverrides.operatorEmail`
 * (docs/seed-spec.md §1). The amount is provisional: docs do not fix it; it is the ceiling of the
 * worst case of the public worlds (ADR-0015 §4) priced with provisional rates, until WP-41 verifies
 * them and the CTO accepts it (docs/pending.md P-07).
 */
export const PROJECT_BUDGET = {
  limitUsdPerMonth: 300,
  notifyAtPercent: [50, 80, 100],
  costTagKey: "Project",
} as const;

/** Inside the `budget/<app>-*` fence of the CI deploy role (bootstrap `ProjectBudget`). */
export function budgetName(app: string, stage: string): string {
  return `${app}-${stage}-monthly`;
}

/** Cost filter by a user-defined cost allocation tag. */
export function budgetCostFilter(project: string): { readonly name: "TagKeyValue"; readonly values: string[] } {
  return { name: "TagKeyValue", values: [`user:${PROJECT_BUDGET.costTagKey}$${project}`] };
}

const ONE_ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/**
 * Who gets the budget's notices: `SeedOverrides.operatorEmail`, read at deploy time. Absent (the
 * secret's initial `{}`) → no subscriber, and infra/observability.ts warns; malformed → the deploy
 * fails. The value is never echoed: the secret holds real addresses.
 */
export function budgetSubscribers(seedOverridesJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(seedOverridesJson);
  } catch {
    throw new Error("SeedOverrides is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("SeedOverrides must be a JSON object");
  const email: unknown = Reflect.get(parsed, "operatorEmail");
  if (email === undefined) return [];
  const address = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!ONE_ADDRESS.test(address)) throw new Error("SeedOverrides.operatorEmail must be one email address (docs/seed-spec.md §1)");
  return [address];
}

/** The notices of the budget, all on the actual cost. */
export function budgetNotifications(subscribers: readonly string[]): Array<{
  readonly comparisonOperator: "GREATER_THAN";
  readonly notificationType: "ACTUAL";
  readonly threshold: number;
  readonly thresholdType: "PERCENTAGE";
  readonly subscriberEmailAddresses: string[];
}> {
  if (subscribers.length === 0) return [];
  return PROJECT_BUDGET.notifyAtPercent.map((threshold) => ({
    comparisonOperator: "GREATER_THAN",
    notificationType: "ACTUAL",
    threshold,
    thresholdType: "PERCENTAGE",
    subscriberEmailAddresses: [...subscribers],
  }));
}

// ---- Reserved concurrency and the daily PolicyAudit (§12) -------------------------------------------

/**
 * "Concurrencia reservada" of docs/architecture.md §12. Each module sets its own (web-spec.ts
 * EDGE_BUDGETS, operations.ts OPERATION_WORKER, messaging-email-spec.ts EMAIL_FUNCTIONS, leads-spec.ts
 * LEADS_FUNCTIONS); the test fails when one drifts from here. The Cognito triggers carry none.
 */
export const RESERVED_CONCURRENCY = {
  OperationWorker: 5,
  Bff: 10,
  PublicWeb: 5,
  InboundEmail: 5,
  SimMail: 5,
  SignupDispatch: 2,
  LeadNotice: 2,
} as const satisfies Partial<Record<LambdaName, number>>;

/**
 * The daily run of PolicyAudit: 03:00 ART (06:00 UTC; Argentina keeps UTC−3 all year), before the
 * nightly reset of reserved guest worlds at 04:00 ART, over the last 26 hours. The event names no
 * firm: packages/bff/src/handlers/policy-audit.ts lists the `DEMO` and `GUEST` firms at run time. The
 * test keeps `enabled` in step with what the handler accepts, in either direction.
 */
export const POLICY_AUDIT = {
  schedule: "cron(0 6 * * ? *)",
  event: { kind: "DAILY" },
  enabled: true,
  timeoutSeconds: 900,
  memoryMb: 512,
} as const;
