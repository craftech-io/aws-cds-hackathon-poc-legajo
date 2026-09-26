// In-process `OperationEvents.fifo` (docs/architecture.md §7): what producers send with
// `SendMessage` stays here, deduplicated by `MessageDeduplicationId` and ordered by arrival, and
// `drain` hands it to the worker one record per event (batch 1), with the receive count SQS would
// report. A record that fails is received again until `maxReceiveCount`, then goes to the dead
// letters, like the stage's redrive policy.
import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

/** Receives before the dead-letter queue (`maxReceiveCount` of the stage). */
export const MAX_RECEIVE_COUNT = 2;

export interface QueuedMessage {
  readonly messageId: string;
  readonly queueUrl: string;
  readonly body: string;
  readonly groupId?: string;
  readonly dedupId?: string;
  readonly sentAtMs: number;
  receiveCount: number;
}

export type QueueHandler = (event: SQSEvent) => Promise<SQSBatchResponse | void>;

export interface DrainOptions {
  readonly maxReceiveCount?: number;
  /** Guard against a handler that keeps enqueuing forever. */
  readonly maxDeliveries?: number;
}

export interface FifoQueue {
  /** Every `SendMessage` input, duplicates included. */
  readonly sent: SendMessageCommandInput[];
  readonly deadLetters: QueuedMessage[];
  /** `SendMessage`: answers the message id (the original one for a duplicate). */
  send(input: SendMessageCommandInput): { readonly MessageId: string; readonly duplicate: boolean };
  pending(): readonly QueuedMessage[];
  /** Delivers until the queue is empty; answers how many deliveries succeeded. */
  drain(handler: QueueHandler, options?: DrainOptions): Promise<number>;
}

function queueArn(queueUrl: string): string {
  const name = queueUrl.split("/").pop() ?? "queue";
  return `arn:aws:sqs:us-east-1:000000000000:${name}`;
}

function record(message: QueuedMessage): SQSRecord {
  return {
    messageId: message.messageId,
    receiptHandle: `rh-${message.messageId}-${message.receiveCount}`,
    body: message.body,
    attributes: {
      ApproximateReceiveCount: String(message.receiveCount),
      SentTimestamp: String(message.sentAtMs),
      SenderId: "local-flows",
      ApproximateFirstReceiveTimestamp: String(message.sentAtMs),
      ...(message.groupId === undefined ? {} : { MessageGroupId: message.groupId }),
      ...(message.dedupId === undefined ? {} : { MessageDeduplicationId: message.dedupId }),
    },
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: queueArn(message.queueUrl),
    awsRegion: "us-east-1",
  };
}

export function createFifoQueue(options: { readonly now?: () => Date } = {}): FifoQueue {
  const now = options.now ?? (() => new Date());
  const sent: SendMessageCommandInput[] = [];
  const deadLetters: QueuedMessage[] = [];
  const queue: QueuedMessage[] = [];
  const seen = new Map<string, string>();
  let counter = 0;

  return {
    sent,
    deadLetters,
    send(input) {
      sent.push(input);
      const queueUrl = input.QueueUrl ?? "";
      const dedupKey = input.MessageDeduplicationId === undefined ? undefined : `${queueUrl}#${input.MessageDeduplicationId}`;
      const original = dedupKey === undefined ? undefined : seen.get(dedupKey);
      if (original !== undefined) return { MessageId: original, duplicate: true };
      counter += 1;
      const messageId = `msg-local-${String(counter).padStart(6, "0")}`;
      if (dedupKey !== undefined) seen.set(dedupKey, messageId);
      queue.push({
        messageId,
        queueUrl,
        body: input.MessageBody ?? "",
        ...(input.MessageGroupId === undefined ? {} : { groupId: input.MessageGroupId }),
        ...(input.MessageDeduplicationId === undefined ? {} : { dedupId: input.MessageDeduplicationId }),
        sentAtMs: now().getTime(),
        receiveCount: 0,
      });
      return { MessageId: messageId, duplicate: false };
    },
    pending: () => [...queue],
    async drain(handler, drainOptions = {}) {
      const maxReceiveCount = drainOptions.maxReceiveCount ?? MAX_RECEIVE_COUNT;
      const maxDeliveries = drainOptions.maxDeliveries ?? 1_000;
      let deliveries = 0;
      let succeeded = 0;
      while (queue.length > 0) {
        if (deliveries >= maxDeliveries) throw new Error(`the local queue did not drain after ${maxDeliveries} deliveries`);
        const message = queue.shift() as QueuedMessage;
        message.receiveCount += 1;
        deliveries += 1;
        let failed = false;
        try {
          const response = await handler({ Records: [record(message)] });
          failed = (response?.batchItemFailures ?? []).some((failure) => failure.itemIdentifier === message.messageId);
        } catch {
          failed = true;
        }
        if (!failed) succeeded += 1;
        else if (message.receiveCount >= maxReceiveCount) deadLetters.push(message);
        // FIFO: a failed message blocks its group, so it is received again before anything after it.
        else queue.unshift(message);
      }
      return succeeded;
    },
  };
}
