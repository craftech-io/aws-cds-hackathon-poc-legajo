// Lambda entry of `FeedEvents` (docs/architecture-integrations.md §6), the target of the `Feeds` bus
// rule of infra/feeds.ts (`CarrierEtaChanged`, `CustomsStatusChanged` of the platform mock). The work is
// feeds/feed-events.ts; its ports are built on the first invocation of a container (feeds/stage.ts), so
// importing this module reads nothing. A failure to enqueue throws, and EventBridge delivers the event
// again (the duplicate mark is written only after the queue took it).
import { type FeedEventsDeps, type FeedOutcome, processFeedEvent } from "../feeds/feed-events";
import { stageFeedEventsDeps } from "../feeds/stage";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";

export type FeedEventsHandler = (event: unknown) => Promise<{ readonly status: FeedOutcome }>;

export function createFeedEventsHandler(depsFor: (log: Logger) => FeedEventsDeps, newLog: () => Logger = () => createLogger({ correlationId: newCorrelationId(), bindings: { service: "feed-events" } })): FeedEventsHandler {
  return async (event) => {
    const log = newLog();
    return { status: await processFeedEvent(event, depsFor(log)) };
  };
}

export const handler: FeedEventsHandler = createFeedEventsHandler((log) => stageFeedEventsDeps(log));
