import { describe, expect, it } from "vitest";
import { WHATSAPP_METRICS, applyStatuses, nextStatus, statusEventId } from "./events";
import { processWhatsAppEvent } from "./inbound";
import type { WaStatus } from "./payloads";
import { PHONE, type WaWorld, liveEvent, sentWithButtons, waWorld } from "./testing";

const SENT = "wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABEYEjdBQkZFM0U4RjBGMzQ1RjY3RgA=";
const MARKETING = "wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABEYEjdBQkZFM0U4RjBGMzQ1RjY3RgB=";
const FAILED = "wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABEYEjdBQkZFM0U4RjBGMzQ1RjY3RgC=";

/** Three messages of ours, sent live (status SENT), one of them a template. */
async function sentMessages(world: WaWorld) {
  const ids = [];
  for (const [wamid, template] of [[SENT, true], [MARKETING, true], [FAILED, false]] as const) {
    const sent = await sentWithButtons(world, [{ action: "QUESTION" }], { wamid, template });
    await world.stores.connector.conversations.updateMessage({ operationId: "op-4471", messageId: sent.messageId, sentAtSim: "2026-10-14T13:30:00.000Z" }, { status: "SENT" });
    ids.push(sent.messageId);
  }
  return ids;
}

async function statusOf(world: WaWorld, messageId: string) {
  return (await world.stores.connector.conversations.getMessage("op-4471", messageId))?.status;
}

describe("[FL-092] statuses and pricing category of live WhatsApp", () => {
  it("[FL-092] sent, delivered and read move the message forward and leave one event each", async () => {
    const world = await waWorld();
    const [messageId = ""] = await sentMessages(world);
    await processWhatsAppEvent(liveEvent("sns-statuses.json", { SENT_ID: SENT, MARKETING_ID: MARKETING, FAILED_ID: FAILED }), world.deps);
    expect(await statusOf(world, messageId)).toBe("READ");
    const events = (await world.stores.connector.conversations.listMessageEvents("op-4471")).filter((event) => event.messageId === messageId);
    expect(events.map((event) => [event.type, event.atReal, event.simulated])).toEqual([
      ["SENT", "2026-10-15T13:05:00.000Z", false],
      ["DELIVERED", "2026-10-15T13:05:02.000Z", false],
      ["READ", "2026-10-15T13:06:00.000Z", false],
    ]);
    expect(events[0]?.detail).toEqual({ pricingCategory: "utility" });
    // A delivery that arrives after the read never takes the message back.
    const late: WaStatus = { id: SENT, status: "delivered", timestamp: "1792069600", recipient_id: PHONE.slice(1) };
    expect(await applyStatuses([late], { conversations: world.stores.connector.conversations, log: world.deps.log }, false)).toEqual([{ outcome: "UNCHANGED", messageId }]);
    expect(await statusOf(world, messageId)).toBe("READ");
  });

  it("[FL-092] a failure keeps Meta's error code and title and raises its metric, without the recipient", async () => {
    const world = await waWorld();
    const [, , failedId = ""] = await sentMessages(world);
    await processWhatsAppEvent(liveEvent("sns-statuses.json", { SENT_ID: SENT, MARKETING_ID: MARKETING, FAILED_ID: FAILED }), world.deps);
    expect(await statusOf(world, failedId)).toBe("FAILED");
    const failure = (await world.stores.connector.conversations.listMessageEvents("op-4471")).find((event) => event.type === "FAILED");
    expect(failure?.detail).toEqual({ errorCode: 131047, errorTitle: "Re-engagement message" });
    const alarm = world.logs().find((line) => line.metric === WHATSAPP_METRICS.sendFailed);
    expect(alarm).toMatchObject({ level: "error", errorCode: 131047, messageId: failedId });
    expect(JSON.stringify(world.logs())).not.toContain(PHONE.slice(1));
  });

  it("[FL-092] a template billed outside utility is recorded and raises the alarm's metric; utility does not", async () => {
    const world = await waWorld();
    const [, marketingId = ""] = await sentMessages(world);
    await processWhatsAppEvent(liveEvent("sns-statuses.json", { SENT_ID: SENT, MARKETING_ID: MARKETING, FAILED_ID: FAILED }), world.deps);
    const alarms = world.logs().filter((line) => line.metric === WHATSAPP_METRICS.pricingCategory);
    expect(alarms).toMatchObject([{ level: "error", category: "marketing", template: "legajo_docs_pendientes", messageId: marketingId }]);
    const billed = (await world.stores.connector.conversations.listMessageEvents("op-4471")).find((event) => event.messageId === marketingId);
    expect(billed?.detail).toEqual({ pricingCategory: "marketing" });
  });

  it("[FL-092] a repeated status is one event; a status of a message that is not ours changes nothing", async () => {
    const world = await waWorld();
    const [messageId = ""] = await sentMessages(world);
    const delivered: WaStatus = { id: SENT, status: "delivered", timestamp: "1792069502", recipient_id: PHONE.slice(1) };
    const deps = { conversations: world.stores.connector.conversations, log: world.deps.log };
    expect(await applyStatuses([delivered, delivered], deps, false)).toEqual([{ outcome: "APPLIED", messageId, status: "DELIVERED" }, { outcome: "DUPLICATE", messageId }]);
    expect(await applyStatuses([{ ...delivered, id: "wamid.HBgNUNKNOWN" }], deps, false)).toEqual([{ outcome: "UNKNOWN_MESSAGE" }]);
    expect(world.logs().filter((line) => line.metric === WHATSAPP_METRICS.unknownStatus)).toHaveLength(1);
    expect(statusEventId(delivered)).toMatch(/^wa-delivered-[0-9a-f]{40}$/);
  });
});

describe("status order", () => {
  it("only moves forward, and a failure never overrides a read", () => {
    expect(nextStatus("SENT", "delivered")).toBe("DELIVERED");
    expect(nextStatus("DELIVERED", "sent")).toBeUndefined();
    expect(nextStatus("READ", "failed")).toBeUndefined();
    expect(nextStatus("SENT", "failed")).toBe("FAILED");
    expect(nextStatus("DEFERRED", "delivered")).toBeUndefined();
  });
});
