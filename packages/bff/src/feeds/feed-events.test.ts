import { describe, expect, it } from "vitest";
import { FEED_METRICS, processFeedEvent } from "./feed-events";
import { CUSTOMS_EVENT_ID, ETA_EVENT_ID, approve, customsEnvelope, etaEnvelope, feedWorld } from "./testing";

const metric = (lines: readonly string[], name: string) => lines.filter((line) => line.includes(`"metric":"${name}"`));

describe("FeedEvents: CarrierEtaChanged", () => {
  it("resolves the operation by firm and number and enqueues ETA_CHANGED with the feed's eventId", async () => {
    const world = await feedWorld();
    expect(await processFeedEvent(etaEnvelope(), world.deps)).toBe("ENQUEUED");
    expect(world.enqueued).toEqual([
      {
        type: "ETA_CHANGED",
        eventId: ETA_EVENT_ID,
        operationId: "op-4471",
        clockId: "GLOBAL#firm-delta",
        firmId: "firm-delta",
        eventAtSim: "2026-10-16T09:30:00-03:00",
        occurredAtSim: "2026-10-16T09:30:00-03:00",
        eta: "2026-10-20T08:00:00-03:00",
        previousEta: "2026-10-22T08:00:00-03:00",
      },
    ]);
    const opState = await world.email.stores.connector.world.getOpState("op-4471");
    expect(opState?.inFlight ?? []).toContain(ETA_EVENT_ID);
  });

  it("[FL-064] the same eventId twice enqueues once", async () => {
    const world = await feedWorld();
    expect(await processFeedEvent(etaEnvelope(), world.deps)).toBe("ENQUEUED");
    expect(await processFeedEvent(etaEnvelope(), world.deps)).toBe("DUPLICATE");
    expect(world.enqueued).toHaveLength(1);
  });

  it("[FL-064] a failed enqueue leaves the event unseen, so EventBridge's retry still delivers it", async () => {
    const failing = await feedWorld({ failEnqueue: true });
    await expect(processFeedEvent(etaEnvelope(), failing.deps)).rejects.toThrow("SendMessage failed");
    expect(await failing.email.stores.connector.runtime.getIdempotency("FEED", ETA_EVENT_ID)).toBeUndefined();
  });

  it("a number of another firm, or one no operation has, enqueues nothing and is counted", async () => {
    const world = await feedWorld();
    expect(await processFeedEvent(etaEnvelope({ firmId: "firm-guest-41" }), world.deps)).toBe("UNKNOWN_OPERATION");
    expect(await processFeedEvent(etaEnvelope({ eventId: "evt_01JQ7ZK8X4M2N6P9R3T5V7W9Y3", operationNumber: "9999" }), world.deps)).toBe("UNKNOWN_OPERATION");
    expect(world.enqueued).toEqual([]);
    expect(metric(world.lines, FEED_METRICS.unknownOperation)).toHaveLength(2);
  });

  it("an operation of an epoch that was reset away is not a match", async () => {
    const world = await feedWorld();
    await world.email.stores.connector.world.putTombstone({ clockId: "GLOBAL#firm-delta", worldEpoch: 1, atReal: "2026-09-26T15:00:00.000Z" });
    expect(await processFeedEvent(etaEnvelope(), world.deps)).toBe("UNKNOWN_OPERATION");
  });

  it("an envelope that does not validate (wrong source, extra detail field) is dropped without content in the log", async () => {
    const world = await feedWorld();
    const envelope = etaEnvelope() as { detail: Record<string, unknown> };
    expect(await processFeedEvent({ ...envelope, source: "attacker.platform" }, world.deps)).toBe("INVALID");
    expect(await processFeedEvent({ ...envelope, detail: { ...envelope.detail, extra: "x" } }, world.deps)).toBe("INVALID");
    expect(world.enqueued).toEqual([]);
    expect(metric(world.lines, FEED_METRICS.invalid)).toHaveLength(2);
    expect(world.lines.join("\n")).not.toContain("Austral Aurora");
  });
});

describe("FeedEvents: CustomsStatusChanged", () => {
  it("an approved dossier gets DISPATCH_STATUS with the status and channel", async () => {
    const world = await feedWorld();
    await approve(world);
    expect(await processFeedEvent(customsEnvelope({ status: "CANAL_ASIGNADO", channel: "NARANJA" }), world.deps)).toBe("ENQUEUED");
    expect(world.enqueued).toMatchObject([{ type: "DISPATCH_STATUS", eventId: CUSTOMS_EVENT_ID, operationId: "op-4471", status: "CANAL_ASIGNADO", channel: "NARANJA", eventAtSim: "2026-10-21T11:00:00-03:00" }]);
  });

  it("[FL-078] a status before approval is recorded as DISPATCH_BEFORE_APPROVAL and never enqueued", async () => {
    const world = await feedWorld();
    expect(await processFeedEvent(customsEnvelope(), world.deps)).toBe("BEFORE_APPROVAL");
    expect(await processFeedEvent(customsEnvelope(), world.deps)).toBe("DUPLICATE");
    expect(world.enqueued).toEqual([]);
    const trail = await world.email.stores.connector.audit.listByOperation("op-4471");
    expect(trail.filter((decision) => decision.action === "DISPATCH_BEFORE_APPROVAL")).toHaveLength(1);
    expect(trail.find((decision) => decision.action === "DISPATCH_BEFORE_APPROVAL")).toMatchObject({ decision: "ACTION", actor: "SYSTEM", refs: { eventId: CUSTOMS_EVENT_ID } });
  });
});
