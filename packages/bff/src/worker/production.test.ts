import { describe, expect, it } from "vitest";
import { memoryStores } from "../connector/testing";
import { productionEventHandlers } from "./production";
import type { EventHandlers } from "./ports";

describe("the worker's production handlers", () => {
  it("wires a handler for every event type without reading a link at build time", () => {
    const { connector } = memoryStores();
    const handlers = productionEventHandlers(connector, { enqueue: async () => undefined }, () => new Date("2026-09-26T15:00:00.000Z"));
    const types: ReadonlyArray<keyof EventHandlers> = ["intakeDocument", "fireTimer", "rescheduleOnEtaChange", "notifyDispatchStatus", "applyEmailEvent", "outboundSend", "milestoneFallback"];
    expect(Object.keys(handlers).sort()).toEqual([...types].sort());
    for (const type of types) expect(typeof handlers[type], type).toBe("function");
  });
});
