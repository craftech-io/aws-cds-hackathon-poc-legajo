// Observability (docs/architecture.md §12, ADR-0015 §9, docs/build-plan.md WP-32). Names, patterns,
// thresholds and the budget live in infra/observability-spec.ts (checked by its test).
//
//   Logs      Every Lambda's log group is created by SST with the 30-day retention of the
//             $transform in sst.config.ts. The Harness runtime group of the `live` endpoint is created
//             by infra/agentcore.ts before that endpoint, also with 30 days; `DEFAULT` is AgentCore's
//             and stays empty. The code writes one JSON line per event (packages/bff/src/lib/log.ts).
//   Metrics   `LegajoAgent/*`: one CloudWatch Logs metric filter per metric and emitting function, over
//             the group SST creates for it (`fn.nodes.logGroup`; its name does not follow the function
//             name, SST draws a separate suffix for each). WAF publishes its own per-rule metrics in
//             `AWS/WAFV2` at no extra cost.
//   Alarms    The ones of §12: DLQ of OperationEvents > 0, PolicyViolations, TurnErrors, TurnCapHits,
//             ReaderErrors, MalwareFindings, the account's SES bounce rate at 2 %, and the signup's
//             (AccountMailBlocked, AccountMailBreakerOpen, SignupDispatchFailed, GuestBudgetHits,
//             LeadNoticeFailed). Missing data is never a breach. They notify nobody yet: who receives
//             them is a decision for `architect` (an SNS topic needs an email confirmation by hand).
//             The QaDriver reads the history of the DLQ alarm through the Linkable `DlqAlarm`.
//   Budget    `aws.budgets.Budget` `<app>-<stage>-monthly`, filtered by the cost allocation tag
//             `Project` (docs/architecture.md §17 item 8), notices at 50, 80 and 100 % of the actual cost
//             to `SeedOverrides.operatorEmail`, read at deploy time. The hard cap of turns is the
//             worker's `TURNCAP#` (§7), not an alarm.
//
// Declared manual configuration, account-wide (docs/architecture.md §17 item 2): Transaction Search and
// the 30-day retention of `aws/spans`. Model Invocation Logging stays disabled (nothing here enables it).
//
// Cost: metric filters are free; a custom metric bills by the hour only while it receives data;
// 13 alarm metrics at US$ 0.10 a month each; the budget's first two are free per account.
//
// Verify:
//   aws --profile craftech-demos logs describe-metric-filters --log-group-name <log group of Bff>
//     → one filter per metric of observability-spec.ts whose emitters include Bff
//   aws --profile craftech-demos cloudwatch describe-alarms --alarm-name-prefix aws-cds-hackathon-poc-legajo-poc-
//     --query "MetricAlarms[].[AlarmName,StateValue]"                                      → the 12 alarms, OK
//   aws --profile craftech-demos cloudwatch describe-alarms --alarm-names aws-cds-hackathon-poc-legajo-poc-operation-events-dlq
//     → metrics of QueueName aws-cds-hackathon-poc-legajo-poc-OperationEventsDlq.fifo
//   aws --profile craftech-demos budgets describe-budget --account-id 776805327629 --budget-name aws-cds-hackathon-poc-legajo-poc-monthly
//   aws --profile craftech-demos budgets describe-notifications-for-budget --account-id 776805327629 --budget-name aws-cds-hackathon-poc-legajo-poc-monthly
//   aws --profile craftech-demos xray get-trace-segment-destination                        → CloudWatchLogs
//   aws --profile craftech-demos bedrock get-model-invocation-logging-configuration        → no loggingConfig

import { toolFunctions } from "./agent-tools";
import { TOOL_FUNCTIONS } from "./agentcore-spec";
import { triggerFunctions } from "./auth";
import { COGNITO_TRIGGERS, TRIGGER_KEYS } from "./auth-spec";
import { bff, policyAudit, publicWeb, qaDriver } from "./bff";
import { feedEvents } from "./feeds";
import type { LambdaName } from "./iam-capabilities";
import { leadNotice, signupDispatch } from "./leads";
import { phoneOtp } from "./phone";
import { channelEvents, inboundEmail, simMail } from "./messaging-email";
import { inboundWhatsApp } from "./messaging-whatsapp";
import { platformMockApi, readerMockApi } from "./mocks";
import {
  ALARMS,
  DLQ_ALARM_ACTIONS,
  DLQ_ALARM_KEY,
  DLQ_ALARM_LINK,
  METRIC_NAMESPACE,
  PROJECT_BUDGET,
  alarmName,
  alarmQueries,
  budgetCostFilter,
  budgetName,
  budgetNotifications,
  budgetSubscribers,
  metricFilterSpecs,
  type AlarmKey,
  type AlarmSpec,
} from "./observability-spec";
import { documentIntake, operationEventsDlqQueue, operationWorker } from "./operations";
import { scheduleDispatch, worldJanitor } from "./scheduler";
import { SeedOverrides } from "./secrets";
import { PROJECT } from "./tags";

const fromEntries = <K extends string, V>(entries: Array<readonly [K, V]>): Record<K, V> => Object.fromEntries(entries) as Record<K, V>;

/** Every Lambda of iam-capabilities.ts, by name: a metric can only name an emitter that exists. */
const functions = {
  OperationWorker: operationWorker,
  DocumentIntake: documentIntake,
  InboundWhatsApp: inboundWhatsApp,
  InboundEmail: inboundEmail,
  SimMail: simMail,
  ChannelEvents: channelEvents,
  FeedEvents: feedEvents,
  ScheduleDispatch: scheduleDispatch,
  WorldJanitor: worldJanitor,
  SignupDispatch: signupDispatch,
  LeadNotice: leadNotice,
  ReaderMock: readerMockApi,
  PlatformMock: platformMockApi,
  Bff: bff,
  PublicWeb: publicWeb,
  QaDriver: qaDriver,
  PolicyAudit: policyAudit,
  PhoneOtp: phoneOtp,
  ...fromEntries(Object.entries(TOOL_FUNCTIONS).map(([target, fn]) => [fn, toolFunctions[target as keyof typeof toolFunctions]] as const)),
  ...fromEntries(TRIGGER_KEYS.map((key) => [COGNITO_TRIGGERS[key].fn, triggerFunctions[key]] as const)),
} satisfies Record<LambdaName, sst.aws.Function>;

/** The group SST created for a function and the function logs to (`loggingConfig.logGroup`). */
function logGroupName(fn: LambdaName): $util.Output<string> {
  return functions[fn].nodes.logGroup.apply((group) => {
    if (group === undefined) throw new Error(`${fn} has no SST log group; sst.config.ts gives every Function logging.retention, and its metric filters need it.`);
    return group.name;
  });
}

// ---- Metric filters -------------------------------------------------------------------------------------

export const metricFilters: aws.cloudwatch.LogMetricFilter[] = metricFilterSpecs().map(
  (spec) =>
    new aws.cloudwatch.LogMetricFilter(spec.logicalName, {
      logGroupName: logGroupName(spec.emitter),
      pattern: spec.pattern,
      metricTransformation: {
        name: spec.metric,
        namespace: METRIC_NAMESPACE,
        value: spec.value,
        unit: spec.unit,
        ...(spec.dimensions === undefined ? {} : { dimensions: { ...spec.dimensions } }),
      },
    }),
);

// ---- Alarms ------------------------------------------------------------------------------------------------

const pascal = (key: string): string =>
  key
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");

/** The DLQ alarm watches the dead letters, never OperationEvents.fifo itself. */
const dlqQueueName = operationEventsDlqQueue.nodes.queue.name;

function createAlarm(spec: AlarmSpec): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm(`Alarm${pascal(spec.key)}`, {
    name: alarmName($app.name, $app.stage, spec.key),
    alarmDescription: spec.description,
    comparisonOperator: spec.comparison,
    threshold: spec.threshold,
    evaluationPeriods: spec.evaluationPeriods,
    datapointsToAlarm: spec.evaluationPeriods,
    treatMissingData: "notBreaching",
    metricQueries: alarmQueries(spec, dlqQueueName).map((query) => ({
      id: query.id,
      returnData: query.returnData,
      ...(query.label === undefined ? {} : { label: query.label }),
      ...(query.expression === undefined ? {} : { expression: query.expression }),
      ...(query.metric === undefined
        ? {}
        : {
            metric: {
              namespace: query.metric.namespace,
              metricName: query.metric.metricName,
              stat: query.metric.stat,
              period: query.metric.period,
              ...(query.metric.dimensions === undefined ? {} : { dimensions: { ...query.metric.dimensions } }),
            },
          }),
    })),
  });
}

export const alarms = fromEntries(ALARMS.map((spec) => [spec.key, createAlarm(spec)] as const)) as Readonly<Record<AlarmKey, aws.cloudwatch.MetricAlarm>>;

const dlqAlarm = alarms[DLQ_ALARM_KEY];

/** The QaDriver's view of the DLQ alarm (`alarm.history`): `Resource.DlqAlarm.name` and DescribeAlarmHistory on it only. */
export const DlqAlarm = new sst.Linkable(DLQ_ALARM_LINK, {
  properties: { name: dlqAlarm.name },
  include: [sst.aws.permission({ actions: [...DLQ_ALARM_ACTIONS], resources: [dlqAlarm.arn] })],
});

// ---- Project budget ------------------------------------------------------------------------------------------

// `operatorEmail` of the secret, never echoed; without it the budget exists without notices.
const subscribers = SeedOverrides.value.apply((json) => {
  const emails = budgetSubscribers(json);
  if (emails.length === 0) $util.log.warn("SeedOverrides has no operatorEmail: the project budget has no notices (docs/seed-spec.md §1).");
  return emails;
});

export const projectBudget = new aws.budgets.Budget("ProjectBudget", {
  name: budgetName($app.name, $app.stage),
  budgetType: "COST",
  limitAmount: String(PROJECT_BUDGET.limitUsdPerMonth),
  limitUnit: "USD",
  timeUnit: "MONTHLY",
  costFilters: [budgetCostFilter(PROJECT)],
  notifications: subscribers.apply(budgetNotifications),
});
