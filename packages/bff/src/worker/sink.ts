// Producer side of `OperationEvents.fifo` (docs/architecture.md §7), the one every producer uses: the
// channel entries (`ChannelEventSink`), the console, the QaDriver, the timers and the worker itself.
//
//   1. the event is validated (a malformed event is a bug, never a queue message);
//   2. `ADD` of the event id to `OPSTATE#<operationId>.inFlight` and of `<operationId>#<eventId>` to
//      `WORLDSTATE#<clockId>.inFlight`, before the message exists, so quiescence never misses it;
//   3. `SendMessage` with `MessageGroupId = operationId` (the events of an operation run one at a time,
//      in order) and `MessageDeduplicationId = eventId` (a repeat within 5 minutes is dropped by SQS).
//
// Both writes are idempotent: a duplicate that SQS drops leaves the sets balanced, because the worker
// takes the id out once when it finishes the event. `SendMessage` is retried with backoff; the SDK
// already retries throttling and connection errors inside each attempt.
import { SQSClient, SendMessageCommand, type SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { z } from "zod";
import type { ChannelEventSink } from "../channels/adapter";
import type { WorldPort } from "../connector/index";
import { awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { OperationQueueEvent, type OperationQueueEventInput, isOperationScoped, messageGroupOf } from "./events";

const REGION = "us-east-1";

/** SQS answers in tens of milliseconds; a send that takes seconds is an outage. */
export const QUEUE_TIMEOUTS = { requestTimeoutMs: 3_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;
export const SEND_ATTEMPTS = 3;

export interface OperationEventSink extends ChannelEventSink {
  enqueue(event: OperationQueueEventInput): Promise<void>;
}

export type QueueSend = (input: SendMessageCommandInput) => Promise<unknown>;

export interface QueueSinkDeps {
  readonly world: Pick<WorldPort, "markInFlight">;
  readonly send: QueueSend;
  readonly queueUrl: () => string;
  /** Injected for tests (backoff between attempts). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What SQS gets: the validated event as JSON, grouped by operation and deduplicated by event id. */
export function sendMessageInput(queueUrl: string, event: OperationQueueEvent): SendMessageCommandInput {
  return {
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(event),
    MessageGroupId: messageGroupOf(event),
    MessageDeduplicationId: event.eventId,
  };
}

/** A send that failed after its attempts; the caller decides (an entry fails, a turn tool answers UNAVAILABLE). */
export class EnqueueError extends Error {
  override readonly name = "EnqueueError";
  readonly retryable = true;
}

export function createQueueSink(deps: QueueSinkDeps): OperationEventSink {
  return {
    async enqueue(input) {
      const event = OperationQueueEvent.parse(input);
      if (isOperationScoped(event)) await deps.world.markInFlight({ operationId: event.operationId, clockId: event.clockId, eventId: event.eventId });
      const message = sendMessageInput(deps.queueUrl(), event);
      try {
        await withRetry(() => deps.send(message), { attempts: SEND_ATTEMPTS, shouldRetry: () => true, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) });
      } catch (error) {
        throw new EnqueueError(`SendMessage of ${event.type} failed`, { cause: error });
      }
    },
  };
}

const QueueLink = z.object({ url: z.url() });

let sqs: SQSClient | undefined;

function sqsClient(): SQSClient {
  sqs ??= new SQSClient({ region: REGION, ...awsClientConfig(QUEUE_TIMEOUTS) });
  return sqs;
}

/** The sink of a Lambda that links `OperationEvents` (its url and `sqs:SendMessage` on that queue only). */
export function linkedQueueSink(world: Pick<WorldPort, "markInFlight">): OperationEventSink {
  return createQueueSink({
    world,
    send: (input) => sqsClient().send(new SendMessageCommand(input)),
    queueUrl: () => readLinked("OperationEvents", QueueLink).url,
  });
}
