// Port through which the mock publishes its events (docs/build-plan.md WP-16: "PutEvents al bus por un
// puerto inyectable"). The Lambda wires the EventBridge adapter to the stage's `Feeds` bus; tests and
// the local flows wire the recording one and read what would have reached the bus.
import { PutEventsCommand, type EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { ConnectorError } from "@legajo/shared";
import { PlatformFeedEvent, toPutEventsEntry } from "./events";

export interface PlatformEventPublisher {
  /** Resolves once the bus accepted the event; ConnectorError UNAVAILABLE otherwise. */
  publish(event: PlatformFeedEvent): Promise<void>;
}

export type EventBridgeSender = Pick<EventBridgeClient, "send">;

export interface EventBridgePublisherOptions {
  readonly client: EventBridgeSender;
  /** Name (or ARN) of the `Feeds` bus (`Resource.Feeds.name`). */
  readonly busName: string;
}

export function createEventBridgePublisher(options: EventBridgePublisherOptions): PlatformEventPublisher {
  return {
    async publish(event) {
      const entry = toPutEventsEntry(event, options.busName);
      let failed: string | undefined;
      try {
        const output = await options.client.send(new PutEventsCommand({ Entries: [entry] }));
        // PutEvents answers 200 even when an entry was rejected; the entry carries the error.
        if ((output.FailedEntryCount ?? 0) > 0) failed = output.Entries?.[0]?.ErrorCode ?? "EntryFailed";
      } catch (error) {
        throw new ConnectorError("UNAVAILABLE", `PutEvents: ${error instanceof Error ? error.name : "UnknownError"}`, undefined, { cause: error });
      }
      if (failed !== undefined) throw new ConnectorError("UNAVAILABLE", `PutEvents: entry rejected (${failed})`);
    },
  };
}

export interface RecordingPublisher extends PlatformEventPublisher {
  /** Every event accepted so far, in order (a replay appears again with the same `eventId`). */
  readonly events: PlatformFeedEvent[];
}

export function createRecordingPublisher(): RecordingPublisher {
  const events: PlatformFeedEvent[] = [];
  return {
    events,
    async publish(event) {
      events.push(structuredClone(PlatformFeedEvent.parse(event)));
    },
  };
}
