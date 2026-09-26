// Orchestration of an operation (docs/architecture.md §7 and §12, ADR-0004, docs/build-plan.md WP-24):
// the FIFO queue every change of an operation goes through, its dead-letter queue, the worker that
// consumes it and `DocumentIntake`, which the malware scan results of Uploads and Media trigger.
//
//   OperationEvents.fifo   MessageGroupId = operationId, so the events of one operation run one at a
//                          time and in order; MessageDeduplicationId = eventId, set by every producer
//                          (content-based deduplication stays off). Visibility 720 s, twice the worker's
//                          timeout; after 2 receives an event goes to OperationEventsDlq.fifo.
//   OperationEventsDlq     14 days of retention, alarm in infra/observability.ts (WP-32), read and
//                          cleaned only by the QaDriver (`dlq.find`, `dlq.delete`).
//   OperationWorker        batch 1, timeout 360 s, reserved concurrency 5, and the event source mapping
//                          capped at the same 5: a receive the function would throttle still counts
//                          toward maxReceiveCount 2 and would dead-letter a healthy event.
//   DocumentIntake         every "Object Scan Result" GuardDuty publishes on the default bus for Uploads
//                          and Media (pattern of infra/malware.ts, WP-06); only NO_THREATS_FOUND goes on
//                          to the intake, the handler (WP-29) decides the rest.
//
// Least privilege (docs/architecture.md §14, infra/iam-capabilities.ts). Producers link the Linkable
// `OperationEvents` (`Resource.OperationEvents.url` + `sqs:SendMessage` on this queue only): linking the
// queue component would grant `sqs:*`. Only the QaDriver links `OperationEventsDlq` (its url and the
// three DLQ actions of `QA_DRIVER_DLQ_ONLY_ACTIONS`). The worker's own statement is the one its event
// source mapping polls with, on OperationEvents.fifo only: Receive, Delete, GetQueueAttributes and
// ChangeMessageVisibility (the last one is also its capability: POISON uses it to reach the DLQ fast).
// Everything else comes by `link` from the module that owns it: storage as iam-capabilities.ts
// declares it (the mail bucket only through its `ops/` route, infra/messaging-email.ts), the SYSTEM
// email sender, the WhatsApp sender, the reader mock, both guardrails, the timers of infra/scheduler.ts
// and the Harness of infra/agentcore.ts. The last two are late links (infra/late-links.ts): scheduler.ts
// imports this module, and agentcore.ts is evaluated after it (`WORKER_LATE_LINKS`). The resource side of
// calling ReaderMock is `grantMockInvoke` of infra/mocks.ts, right after the worker exists.
//
// Names. The queues have fixed physical names, `<app>-<stage>-OperationEvents.fifo` and
// `…-OperationEventsDlq.fifo`, inside the `sqs:<app>-*` fence of the CI deploy role. Nothing here is
// meant to be replaced; if a change ever forces it, deploy the removal first: SQS keeps a deleted name
// for 60 s.
//
// Cost: per request and per invocation; nothing bills while no operation moves.
//
// Verify:
//   aws --profile craftech-demos sqs get-queue-url --queue-name aws-cds-hackathon-poc-legajo-poc-OperationEvents.fifo
//   aws --profile craftech-demos sqs get-queue-attributes --queue-url <url> --attribute-names All
//     → FifoQueue true · ContentBasedDeduplication false · VisibilityTimeout 720 · SqsManagedSseEnabled true ·
//       RedrivePolicy {maxReceiveCount 2, deadLetterTargetArn …-OperationEventsDlq.fifo}
//   aws --profile craftech-demos lambda list-event-source-mappings --function-name <OperationWorker name>
//     → BatchSize 1 · ScalingConfig.MaximumConcurrency 5 · State Enabled
//   aws --profile craftech-demos lambda get-function-concurrency --function-name <OperationWorker name>   → 5
//   aws --profile craftech-demos events list-rule-names-by-target --target-arn <DocumentIntake ARN>       → one rule on default

import { GuardrailG1, GuardrailG2 } from "./guardrail";
import { QA_DRIVER_DLQ_ONLY_ACTIONS, type LambdaName } from "./iam-capabilities";
import { lateLinks, links, type LinkList } from "./late-links";
import { malwareScanEventPatternJson } from "./malware";
import { emailLinks } from "./messaging-email";
import { sendWhatsAppPermissions, whatsAppSenderLinks } from "./messaging-whatsapp";
import { grantMockInvoke, mockLinks } from "./mocks";
import { SessionTokenKey } from "./secrets";
import { mediaBucket, storageLinks, uploadsBucket } from "./storage";

/** The queue and its dead letters (docs/architecture.md §7). */
export const OPERATION_EVENTS = {
  visibilityTimeoutSeconds: 720,
  maxReceiveCount: 2,
  /** SQS's maximum: a dead-lettered event stays readable for the operator and the QaDriver. */
  dlqRetentionSeconds: 14 * 24 * 60 * 60,
} as const;

/** The consumer (docs/architecture.md §7 and §12, "Concurrencia reservada"). */
export const OPERATION_WORKER = {
  timeoutSeconds: 360,
  batchSize: 1,
  reservedConcurrency: 5,
} as const;

/** Lambda entries; each file belongs to the WP that writes the code (docs/build-plan.md §2). */
export const OPERATIONS_HANDLERS = {
  OperationWorker: "packages/bff/src/handlers/operation-worker.handler", // WP-28
  DocumentIntake: "packages/bff/src/handlers/document-intake.handler", // WP-29
} as const satisfies Partial<Record<LambdaName, string>>;

/** What the event source mapping polls with; granted on OperationEvents.fifo and nothing else. */
export const QUEUE_CONSUMER_ACTIONS = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"] as const;

/** The only actions a producer gets on the queue. */
export const QUEUE_PRODUCER_ACTIONS = ["sqs:SendMessage"] as const;

/** Tag GuardDuty's scan result lands on; DocumentIntake may read it (infra/iam-capabilities.ts). */
export const SCAN_TAG_READ_ACTIONS = ["s3:GetObjectTagging"] as const;

export type OperationQueue = "OperationEvents" | "OperationEventsDlq";

/** Fixed physical name of a queue of the stage. */
export function queueName(app: string, stage: string, queue: OperationQueue): string {
  return `${app}-${stage}-${queue}.fifo`;
}

/**
 * Linkables of infra/agentcore.ts the worker takes late (infra/late-links.ts, mode `required`: the deploy
 * fails when the owner stops exporting them). `Harness`: invoking the Harness (docs/architecture.md §9.1),
 * for the worker only; the memory side lives in `Agent`, which only the WORLDS roles link.
 */
export const WORKER_LATE_LINKS = { agentcore: ["Harness"] } as const;

const accountId = aws.getCallerIdentityOutput({}).accountId;
const region = aws.getRegionOutput({}).region;

// ---- Queues ----------------------------------------------------------------------------------------

export const operationEventsDlqQueue = new sst.aws.Queue("OperationEventsDlqQueue", {
  fifo: true,
  transform: {
    queue: {
      name: queueName($app.name, $app.stage, "OperationEventsDlq"),
      messageRetentionSeconds: OPERATION_EVENTS.dlqRetentionSeconds,
      sqsManagedSseEnabled: true,
    },
  },
});

export const operationEventsQueue = new sst.aws.Queue("OperationEventsQueue", {
  fifo: { contentBasedDeduplication: false },
  visibilityTimeout: `${OPERATION_EVENTS.visibilityTimeoutSeconds} seconds`,
  dlq: { queue: operationEventsDlqQueue.arn, retry: OPERATION_EVENTS.maxReceiveCount },
  transform: {
    queue: {
      name: queueName($app.name, $app.stage, "OperationEvents"),
      sqsManagedSseEnabled: true,
    },
  },
});

/** Producer side of OperationEvents.fifo: `Resource.OperationEvents.url` and `sqs:SendMessage` only. */
export const OperationEvents = new sst.Linkable("OperationEvents", {
  properties: { url: operationEventsQueue.url },
  include: [sst.aws.permission({ actions: [...QUEUE_PRODUCER_ACTIONS], resources: [operationEventsQueue.arn] })],
});

/** The QaDriver's view of the DLQ: `Resource.OperationEventsDlq.url` and Receive, Delete, GetQueueAttributes. */
export const OperationEventsDlq = new sst.Linkable("OperationEventsDlq", {
  properties: { url: operationEventsDlqQueue.url },
  include: [sst.aws.permission({ actions: [...QA_DRIVER_DLQ_ONLY_ACTIONS], resources: [operationEventsDlqQueue.arn] })],
});

// ---- OperationWorker -------------------------------------------------------------------------------

const workerLateLinks: LinkList[] = [
  // TIMERS: infra/scheduler.ts imports this module, so its Linkable arrives late; it always exists.
  lateLinks("operations", "scheduler", () => import("./scheduler"), ["Scheduler"]),
  lateLinks("operations", "agentcore", () => import("./agentcore"), WORKER_LATE_LINKS.agentcore),
];

export const operationWorker = new sst.aws.Function("OperationWorker", {
  description: "Consumes OperationEvents.fifo one event at a time: intake, timers, agent turns, console sends, feeds.",
  handler: OPERATIONS_HANDLERS.OperationWorker,
  timeout: `${OPERATION_WORKER.timeoutSeconds} seconds`,
  // Hashes and copies PDFs of up to 10 MB and streams the Harness; CPU scales with memory.
  memory: "1024 MB",
  concurrency: { reserved: OPERATION_WORKER.reservedConcurrency },
  link: links(
    [
      // The mail bucket is read only through its `ops/` route, which emailLinks brings.
      ...storageLinks("OperationWorker"),
      ...emailLinks("OperationWorker"),
      ...whatsAppSenderLinks,
      ...mockLinks("OperationWorker"),
      GuardrailG1,
      GuardrailG2,
      SessionTokenKey,
      OperationEvents,
    ],
    ...workerLateLinks,
  ),
  permissions: $util
    .all([operationEventsQueue.arn, sendWhatsAppPermissions])
    .apply(([queueArn, whatsApp]) => [{ actions: [...QUEUE_CONSUMER_ACTIONS], resources: [queueArn] }, ...whatsApp]),
});

/** Resource side of calling ReaderMock (infra/mocks.ts): the pair of permissions for the worker's role. */
export const operationWorkerReaderGrants = grantMockInvoke("OperationWorker", operationWorker);

export const operationWorkerSubscription = operationEventsQueue.subscribe(operationWorker.arn, {
  batch: { size: OPERATION_WORKER.batchSize },
  transform: {
    eventSourceMapping: { scalingConfig: { maximumConcurrency: OPERATION_WORKER.reservedConcurrency } },
  },
});

// ---- DocumentIntake --------------------------------------------------------------------------------

export const documentIntake = new sst.aws.Function("DocumentIntake", {
  description: "GuardDuty scan result of an object of Uploads or Media: validates it and enqueues INTAKE_DOCUMENT when clean.",
  handler: OPERATIONS_HANDLERS.DocumentIntake,
  timeout: "60 seconds",
  memory: "256 MB",
  link: [...storageLinks("DocumentIntake"), OperationEvents],
  permissions: [
    {
      actions: [...SCAN_TAG_READ_ACTIONS],
      resources: [$interpolate`${uploadsBucket.arn}/*`, $interpolate`${mediaBucket.arn}/*`],
    },
  ],
});

// GuardDuty publishes scan results on the account's default bus; the pattern is infra/malware.ts's, as is.
const defaultEventBusArn = $interpolate`arn:aws:events:${region}:${accountId}:event-bus/default`;

export const documentIntakeScans = sst.aws.Bus.subscribe("DocumentIntakeScans", defaultEventBusArn, documentIntake.arn, {
  transform: { rule: { eventPattern: malwareScanEventPatternJson } },
});
