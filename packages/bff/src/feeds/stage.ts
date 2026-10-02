// The feeds' ports in a Lambda of the stage (never `process.env`): `FeedEvents` gets the connector and
// the queue producer of `Resource.OperationEvents`; the worker's `notify_dispatch_status` gets the
// outbound pipeline bound to the stage (outbound/stage.ts) and the one Scheduler client.
import { connector, type Connector } from "../connector/index";
import type { Logger } from "../lib/log";
import { sendOutbound } from "../outbound/pipeline";
import { stageOutboundDeps } from "../outbound/stage";
import { eventBridgeScheduler } from "../timers/scheduler-client";
import { linkedQueueSink } from "../worker/sink";
import type { DispatchDeps } from "./dispatch";
import type { FeedEventsDeps } from "./feed-events";

export function stageFeedEventsDeps(log: Logger, data: Connector = connector()): FeedEventsDeps {
  return { data, events: linkedQueueSink(data.world), wallClock: () => new Date(), log };
}

/** What worker/production.ts passes to `dispatchStatusHandler`. */
export function stageDispatchDeps(log: Logger, data: Connector = connector()): DispatchDeps {
  const outbound = stageOutboundDeps(log, { data });
  return { data, send: (request, call) => sendOutbound(outbound, request, call), scheduler: eventBridgeScheduler() };
}
