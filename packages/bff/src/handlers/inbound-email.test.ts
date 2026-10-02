import { beforeEach, describe, expect, it } from "vitest";
import { inboundMessageId } from "../channels/email/inbound-record";
import { type EmailWorld, QINGDAO, REPLY_MAIL_ID, CLOCK, deliver, emailWorld, fixture, inboundDeps, receiptEvent, seedAnsweredRequest, seedPending } from "../channels/email/testing";
import { createLogger } from "../lib/log";
import { createInboundEmailHandler } from "./inbound-email";

let world: EmailWorld;
let lines: string[];

beforeEach(async () => {
  world = await emailWorld();
  lines = [];
});

function handler() {
  const log = createLogger({ level: "debug", sink: (line) => lines.push(line) });
  return createInboundEmailHandler(() => inboundDeps(world), () => log);
}

describe("InboundEmail entry", () => {
  it("[FL-021] runs the mandatory order: intakes and the SUPPLIER_EMAIL turn in flight, then the pending mail closed", async () => {
    await seedAnsweredRequest(world);
    await seedPending(world, { mailId: REPLY_MAIL_ID, from: QINGDAO });
    deliver(world, "ses-entry-1", fixture("reply.eml"));
    const event = receiptEvent({ sesMessageId: "ses-entry-1", recipient: world.op4471.threadAddress, rfcMessageId: "<reply-4471-entry@sim.legajo.demo.craftech.io>" });
    expect(await handler()(event)).toEqual({ outcome: "ENQUEUED", operationId: "op-4471", messageId: inboundMessageId("ses-entry-1") });
    expect(world.sink.events.map((queued) => queued.type)).toEqual(["INTAKE_DOCUMENT", "INTAKE_DOCUMENT", "AGENT_TURN"]);
    expect((await world.stores.connector.world.getOpState("op-4471"))?.inFlight).toHaveLength(3);
    expect(await world.stores.connector.runtime.getMailProbe(REPLY_MAIL_ID)).toMatchObject({ outcome: "ENQUEUED" });
    expect(await world.stores.connector.world.getMailPending(CLOCK, REPLY_MAIL_ID)).toBeUndefined();
  });

  it("[FL-036] a spoofed mail (dmarcVerdict FAIL) is quarantined with no turn", async () => {
    deliver(world, "ses-entry-2", fixture("spoofed.eml"));
    const event = receiptEvent({ sesMessageId: "ses-entry-2", recipient: world.op4471.threadAddress, verdicts: { dmarcVerdict: "FAIL" } });
    const result = await handler()(event);
    expect(result).toMatchObject({ outcome: "QUARANTINED" });
    expect(world.sink.events.map((queued) => queued.type)).not.toContain("AGENT_TURN");
  });

  it("an event that is not a receipt is dropped without its content and without throwing", async () => {
    expect(await handler()({ Records: [{ eventSource: "aws:sns" }] })).toEqual({ outcome: "INVALID" });
    expect(world.sink.events).toEqual([]);
    expect(lines.some((line) => line.includes("inbound_email.invalid_event"))).toBe(true);
  });
});
