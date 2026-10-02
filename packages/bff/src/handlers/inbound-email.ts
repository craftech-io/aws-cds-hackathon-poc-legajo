// Lambda entry of `InboundEmail`: the Lambda action of the receipt rule `ops-poc` of
// infra/messaging-email.ts, after its S3 action stored the raw MIME under the bucket's `poc/ops/`
// prefix. The mandatory order of docs/architecture-integrations.md §2 (idempotency, thread address and
// epoch tombstone, verdicts and DMARC with a single author, automatic replies, `ACTIVE` contact,
// normalization, attachments, thread, turn and closing the pending mail with `PROBE#MAIL#`) is
// channels/email/inbound.ts; this entry only wires the stage's ports (channels/email/adapter.ts) and
// the producer of `OperationEvents.fifo` (worker/sink.ts: `inFlight` first, then `SendMessage`).
//
// An event that is not a receipt is dropped and logged without its content (never retried); any other
// failure throws, so the asynchronous invocation is retried and the idempotency marks keep it single.
import type { InboundEmailDeps, InboundEmailResult } from "../channels/email/inbound";
import { receiveInboundEmail } from "../channels/email/inbound";
import { stageInboundEmailDeps } from "../channels/email/adapter";
import { parseReceiptEvent } from "../channels/email/receipt";
import { connector } from "../connector/index";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";
import { linkedQueueSink } from "../worker/sink";

export type InboundEmailHandler = (event: unknown) => Promise<InboundEmailResult | { readonly outcome: "INVALID" }>;

export function createInboundEmailHandler(depsFor: (log: Logger) => InboundEmailDeps, newLog: () => Logger = () => createLogger({ correlationId: newCorrelationId(), bindings: { service: "inbound-email" } })): InboundEmailHandler {
  return async (event) => {
    const log = newLog();
    try {
      parseReceiptEvent(event);
    } catch {
      log.warn("inbound_email.invalid_event");
      return { outcome: "INVALID" };
    }
    const result = await receiveInboundEmail(event, depsFor(log));
    log.info("inbound_email.done", { outcome: result.outcome, ...(result.reason === undefined ? {} : { reason: result.reason }), ...(result.operationId === undefined ? {} : { operationId: result.operationId }) });
    return result;
  };
}

function stageDeps(log: Logger): InboundEmailDeps {
  const data = connector();
  return stageInboundEmailDeps({ log, data, events: linkedQueueSink(data.world) });
}

export const handler: InboundEmailHandler = createInboundEmailHandler(stageDeps);
