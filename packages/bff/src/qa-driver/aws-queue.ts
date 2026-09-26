// AWS reads of the `QaDriver` that are not a firm's data (docs/architecture.md §14, row `QaDriver`):
//
//   dlq.find, dlq.delete   `OperationEventsDlq.fifo` only (Receive/Delete/GetQueueAttributes on that ARN);
//                          a message is matched by its `MessageDeduplicationId` (= `eventId`, §7) and
//                          must belong to the scenario's world; every other message is left alone,
//                          reported by id only, and comes back after a 2-second visibility
//   alarm.history          `DescribeAlarmHistory` of the DLQ alarm only
//   guardrail.probe        `ApplyGuardrail` of G1 (`Resource.GuardrailG1`) with a known attack string
//
// Every client has its deadline and the SDK's retry budget (lib/clients.ts).
import { ApplyGuardrailCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { CloudWatchClient, DescribeAlarmHistoryCommand } from "@aws-sdk/client-cloudwatch";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient, type Message as SqsMessage } from "@aws-sdk/client-sqs";
import { z } from "zod";
import { ToolError } from "@legajo/shared";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { GUARDRAIL_PROBE_TEXT } from "./contract-inputs";

const REGION = "us-east-1";
const AWS_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 };

/** Visibility of a message the driver looks at and does not take: it goes back to the queue quickly. */
export const DLQ_PEEK_VISIBILITY_SEC = 2;
const DLQ_RECEIVES = 5;

const QueueLink = z.object({ url: z.url() });
const NamedLink = z.object({ name: z.string().min(1) });
const GuardrailLink = z.object({ id: z.string().min(1), version: z.string().min(1) });
const EventBody = z.object({ clockId: z.string().optional(), eventId: z.string().optional() }).loose();

export interface DlqMatch {
  readonly found: boolean;
  /** Dead-lettered events that are not this one (ids only): the suite must not hide a real failure. */
  readonly others: readonly string[];
}

export interface DlqPort {
  find(input: { readonly clockId: string; readonly eventId: string }): Promise<DlqMatch>;
  remove(input: { readonly clockId: string; readonly eventId: string }): Promise<{ readonly deleted: boolean; readonly others: readonly string[] }>;
}

function eventIdOf(message: SqsMessage): string | undefined {
  const dedup = message.Attributes?.MessageDeduplicationId;
  if (dedup !== undefined) return dedup;
  try {
    return EventBody.parse(JSON.parse(message.Body ?? "{}")).eventId;
  } catch {
    return undefined;
  }
}

function clockOf(message: SqsMessage): string | undefined {
  try {
    return EventBody.parse(JSON.parse(message.Body ?? "{}")).clockId;
  } catch {
    return undefined;
  }
}

export function sqsDlq(options: { readonly queueUrl?: () => string; readonly client?: SQSClient } = {}): DlqPort {
  const queueUrl = options.queueUrl ?? (() => readLinked("OperationEventsDlq", QueueLink).url);
  let client = options.client;
  const sqs = (): SQSClient => (client ??= new SQSClient({ region: REGION, ...awsClientConfig(AWS_TIMEOUTS) }));

  async function scan(input: { readonly clockId: string; readonly eventId: string }, take: boolean) {
    const others = new Set<string>();
    let found = false;
    let deleted = false;
    for (let round = 0; round < DLQ_RECEIVES && !(found && (deleted || !take)); round += 1) {
      const page = await sqs().send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl(), MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: DLQ_PEEK_VISIBILITY_SEC, MessageSystemAttributeNames: ["MessageDeduplicationId", "MessageGroupId"] }),
      );
      for (const message of page.Messages ?? []) {
        const eventId = eventIdOf(message);
        if (eventId !== input.eventId) {
          if (eventId !== undefined) others.add(eventId);
          continue;
        }
        const clockId = clockOf(message);
        if (clockId !== undefined && clockId !== input.clockId) throw new ToolError("FORBIDDEN", "that dead-lettered event is not of this world", "QA_FENCE");
        found = true;
        if (take && message.ReceiptHandle !== undefined) {
          await sqs().send(new DeleteMessageCommand({ QueueUrl: queueUrl(), ReceiptHandle: message.ReceiptHandle }));
          deleted = true;
        }
      }
    }
    return { found, deleted, others: [...others] };
  }

  return {
    async find(input) {
      const { found, others } = await scan(input, false);
      return { found, others };
    },
    async remove(input) {
      const { deleted, others } = await scan(input, true);
      return { deleted, others };
    },
  };
}

export interface AlarmTransition {
  readonly at: string;
  readonly from?: string;
  readonly to?: string;
  readonly summary: string;
}

const HistoryData = z.object({ oldState: z.object({ stateValue: z.string() }).loose().optional(), newState: z.object({ stateValue: z.string() }).loose().optional() }).loose();

export function cloudWatchAlarmHistory(options: { readonly alarmName?: () => string; readonly client?: CloudWatchClient } = {}) {
  const alarmName = options.alarmName ?? (() => readLinked("DlqAlarm", NamedLink).name);
  let client = options.client;
  const cloudWatch = (): CloudWatchClient => (client ??= new CloudWatchClient({ region: REGION, ...awsClientConfig(AWS_TIMEOUTS) }));
  return async (since: string): Promise<AlarmTransition[]> => {
    const page = await cloudWatch().send(new DescribeAlarmHistoryCommand({ AlarmName: alarmName(), HistoryItemType: "StateUpdate", StartDate: new Date(since), MaxRecords: 50, ScanBy: "TimestampAscending" }));
    return (page.AlarmHistoryItems ?? []).map((item) => {
      let parsed: z.infer<typeof HistoryData> = {};
      try {
        parsed = HistoryData.parse(JSON.parse(item.HistoryData ?? "{}"));
      } catch {
        parsed = {};
      }
      const from = parsed.oldState?.stateValue;
      const to = parsed.newState?.stateValue;
      return { at: (item.Timestamp ?? new Date(0)).toISOString(), ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), summary: item.HistorySummary ?? "" };
    });
  };
}

export function g1Probe(options: { readonly guardrail?: () => z.infer<typeof GuardrailLink>; readonly client?: BedrockRuntimeClient } = {}) {
  const guardrail = options.guardrail ?? (() => readLinked("GuardrailG1", GuardrailLink));
  let client = options.client;
  const bedrock = (): BedrockRuntimeClient => (client ??= new BedrockRuntimeClient({ region: REGION, ...awsClientConfig(AWS_TIMEOUTS) }));
  return async (text: string = GUARDRAIL_PROBE_TEXT): Promise<{ readonly action: string }> => {
    const { id, version } = guardrail();
    const answer = await bedrock().send(new ApplyGuardrailCommand({ guardrailIdentifier: id, guardrailVersion: version, source: "INPUT", content: [{ text: { text } }] }));
    return { action: answer.action ?? "NONE" };
  };
}
