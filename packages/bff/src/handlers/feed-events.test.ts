import { describe, expect, it } from "vitest";
import { createLogger } from "../lib/log";
import { ETA_EVENT_ID, etaEnvelope, feedWorld } from "../feeds/testing";
import { createFeedEventsHandler } from "./feed-events";

describe("FeedEvents entry", () => {
  it("[FL-064] validates, enqueues ETA_CHANGED once per feed eventId and answers the outcome", async () => {
    const world = await feedWorld();
    const handler = createFeedEventsHandler((log) => ({ ...world.deps, log }), () => world.deps.log);
    expect(await handler(etaEnvelope())).toEqual({ status: "ENQUEUED" });
    expect(await handler(etaEnvelope())).toEqual({ status: "DUPLICATE" });
    expect(world.enqueued.map((event) => [event.type, event.eventId])).toEqual([["ETA_CHANGED", ETA_EVENT_ID]]);
  });

  it("drops an event that is not a platform feed event without throwing (EventBridge would retry it forever)", async () => {
    const world = await feedWorld();
    const lines: string[] = [];
    const log = createLogger({ level: "debug", sink: (line) => lines.push(line) });
    const handler = createFeedEventsHandler((entryLog) => ({ ...world.deps, log: entryLog }), () => log);
    expect(await handler({ source: "aws.ses", "detail-type": "Email Delivered", detail: {} })).toEqual({ status: "INVALID" });
    expect(world.enqueued).toEqual([]);
    expect(lines.some((line) => line.includes('"metric":"FeedEventInvalid"'))).toBe(true);
  });
});
