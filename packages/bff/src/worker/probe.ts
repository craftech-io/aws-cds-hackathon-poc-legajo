// The two events only the QaDriver sends (docs/architecture.md §7):
//
//   HEALTH_PROBE  `GET /v1/health` of the reader with the worker's own role (`SMK/3`): the result goes to
//                 `Runtime/PROBE#<probeId>`, which `probe.mocks` waits for; a reader that does not answer
//                 is a probe with `ok: false`, never a failed event
//   POISON        fails on purpose (FL-098), only in a `qa-*` world: before throwing, the worker sets its
//                 own message's visibility to 0 so the second receive is immediate and the event reaches
//                 the DLQ in minutes instead of 2 × 720 s; the last attempt takes the dead-letter path of
//                 worker.ts like any other event
import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import { z } from "zod";
import type { RuntimePort } from "../connector/index";
import type { ReaderClient } from "../reader/client";
import { awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import type { HealthProbeEvent, PoisonEvent } from "./events";
import { QUEUE_TIMEOUTS } from "./sink";

const REGION = "us-east-1";

export const READER_HEALTH_PROBE = "READER_HEALTH";

export async function runHealthProbe(deps: { readonly runtime: Pick<RuntimePort, "putProbe">; readonly reader: Pick<ReaderClient, "health">; readonly now: () => Date }, event: HealthProbeEvent): Promise<boolean> {
  let ok = false;
  let detail: Record<string, unknown> = {};
  try {
    const health = await deps.reader.health();
    ok = health.status === "ok";
    detail = { readerVersion: health.readerVersion };
  } catch (error) {
    detail = { error: error instanceof Error ? error.name : "unknown" };
  }
  await deps.runtime.putProbe({ probeId: event.probeId, kind: READER_HEALTH_PROBE, ok, detail, atReal: deps.now().toISOString() });
  return ok;
}

/** The failure a `POISON` event ends in; it carries nothing of the event. */
export class PoisonedEventError extends Error {
  override readonly name = "PoisonedEventError";
}

/** Visibility 0 on the worker's own delivery (`sqs:ChangeMessageVisibility` on OperationEvents.fifo). */
export interface QueueVisibility {
  release(receiptHandle: string): Promise<void>;
}

export async function runPoison(queue: QueueVisibility, event: PoisonEvent, receiptHandle: string): Promise<never> {
  await queue.release(receiptHandle);
  throw new PoisonedEventError(`POISON ${event.eventId} failed on purpose`);
}

const QueueLink = z.object({ url: z.url() });
let sqs: SQSClient | undefined;

/** Over `Resource.OperationEvents.url`; the worker's role holds ChangeMessageVisibility on that queue only. */
export function linkedQueueVisibility(): QueueVisibility {
  return {
    async release(receiptHandle) {
      sqs ??= new SQSClient({ region: REGION, ...awsClientConfig(QUEUE_TIMEOUTS) });
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: readLinked("OperationEvents", QueueLink).url, ReceiptHandle: receiptHandle, VisibilityTimeout: 0 }));
    },
  };
}
