import { beforeEach, describe, expect, it } from "vitest";
import { ChannelError } from "@legajo/shared";
import { createLogger } from "../../lib/log";
import { derivedEventId } from "../adapter";
import { BOUNCE_RETRY_DELAY_MS, CONTACT_CHECK_DELAY_MS, type ChannelEventsDeps, parseSesEvent, planEmailEvent, processSesEvent } from "./events";
import { CLOCK, type EmailWorld, FIRM, REAL_NOW, SIM_NOW, emailWorld, jsonFixture } from "./testing";

const SES_ID = "0100019a2b3c4d5e-6f708192-a3b4-45c6-97d8-e9fa0b1c2d3e-000000";
const MAIL_ID = "01JQ7ZK8X4M2N6P9R3T5V7W9Z1";

let world: EmailWorld;

async function seedSent(to: string, awaiting: "SES_EVENT" | "SIMMAIL"): Promise<void> {
  const { conversations, world: state } = world.stores.connector;
  await conversations.appendMessage({
    messageId: "msg-4474out1",
    operationId: world.op4471.operationId,
    firmId: FIRM,
    clockId: CLOCK,
    direction: "OUT",
    channel: "EMAIL",
    kind: "DOCS_REQUEST",
    counterpart: "SUPPLIER",
    contactId: "ctc-qingdao-1",
    to,
    from: world.op4471.threadAddress,
    body: "Hello, we still need the packing list of invoice QBT-2026-0917.",
    status: "SENT",
    author: "AGENT",
    sentAtSim: SIM_NOW,
    sentAtReal: REAL_NOW,
    providerMessageId: SES_ID,
    mailId: MAIL_ID,
  });
  await state.putMailPending({ clockId: CLOCK, mailId: MAIL_ID, from: world.op4471.threadAddress, to, profile: "SYSTEM", awaiting, sentAtReal: REAL_NOW, operationId: world.op4471.operationId });
}

function deps(): ChannelEventsDeps {
  const { conversations, world: state, runtime } = world.stores.connector;
  return { conversations, world: state, pending: { world: state, runtime, now: () => new Date(REAL_NOW) }, events: world.sink, log: createLogger({ level: "warn", sink: () => undefined }) };
}

const pending = () => world.stores.connector.world.getMailPending(CLOCK, MAIL_ID);
const probe = () => world.stores.connector.runtime.getMailProbe(MAIL_ID);
const message = { messageId: "msg-4474out1", status: "SENT" as const, contactId: "ctc-qingdao-1" };

beforeEach(async () => {
  world = await emailWorld();
});

describe("[FL-029] a permanent bounce moves the supplier to another channel", () => {
  it("[FL-029] ChannelEvents enqueues EMAIL_EVENT (derived id) and only then closes the SES_EVENT pending mail", async () => {
    await seedSent("bounce@simulator.amazonses.com", "SES_EVENT");
    expect(await processSesEvent(jsonFixture("ses-bounce-permanent.json"), deps())).toBe("ENQUEUED");
    expect(world.sink.events).toEqual([
      {
        type: "EMAIL_EVENT",
        eventId: derivedEventId("EMAIL_EVENT", `${SES_ID}#BOUNCE#bounce@simulator.amazonses.com`),
        operationId: "op-4471",
        clockId: CLOCK,
        firmId: FIRM,
        eventAtSim: SIM_NOW,
        messageId: "msg-4474out1",
        sesEventType: "BOUNCE",
        bounceType: "Permanent",
        occurredAtReal: "2026-10-21T03:30:04.000Z",
      },
    ]);
    expect((await world.stores.connector.world.getOpState("op-4471"))?.inFlight).toEqual([world.sink.events[0]?.eventId]);
    expect(await pending()).toBeUndefined();
    expect(await probe()).toMatchObject({ outcome: "SES_EVENT", reason: "BOUNCE", operationId: "op-4471" });
  });

  it("[FL-029] apply_email_event: contact and message BOUNCED, an EMAIL_BOUNCED turn and TIMER#CONTACT_CHECK one simulated day later", () => {
    const event = parseSesEvent(jsonFixture("ses-bounce-permanent.json"));
    expect(event).toMatchObject({ type: "BOUNCE", bounceType: "Permanent", recipients: ["bounce@simulator.amazonses.com"] });
    const plan = planEmailEvent({ type: "BOUNCE", bounceType: event?.bounceType, message, atSim: SIM_NOW });
    expect(plan).toEqual({
      messageStatus: "BOUNCED",
      contactStatus: "BOUNCED",
      turn: "EMAIL_BOUNCED",
      timer: { kind: "CONTACT_CHECK", timerId: expect.stringMatching(/^contact-check-[0-9a-f]{16}$/), dueAtSim: new Date(Date.parse(SIM_NOW) + CONTACT_CHECK_DELAY_MS).toISOString() },
      alarm: false,
    });
    expect(plan.timer?.dueAtSim).toBe("2026-10-16T22:10:00.000Z");
  });

  it("[FL-029] a transient bounce leaves the message DELAYED with one TIMER#BOUNCE_RETRY four simulated hours later", () => {
    const event = parseSesEvent(jsonFixture("ses-bounce-transient.json"));
    const plan = planEmailEvent({ type: "BOUNCE", bounceType: event?.bounceType, message, atSim: SIM_NOW });
    expect(plan).toEqual({ messageStatus: "DELAYED", timer: { kind: "BOUNCE_RETRY", timerId: expect.stringMatching(/^bounce-retry-[0-9a-f]{16}$/), dueAtSim: "2026-10-16T02:10:00.000Z" }, alarm: false });
    expect(Date.parse(plan.timer?.dueAtSim ?? "") - Date.parse(SIM_NOW)).toBe(BOUNCE_RETRY_DELAY_MS);
    const again = planEmailEvent({ type: "BOUNCE", bounceType: "Undetermined", message, atSim: "2026-10-16T00:00:00.000Z" });
    expect(again.timer?.timerId).toBe(plan.timer?.timerId);
  });
});

describe("[FL-031] a complaint closes the contact and escalates, without a turn", () => {
  it("[FL-031] the delivery that precedes a simulator complaint does not close the pending mail; the complaint does", async () => {
    await seedSent("complaint@simulator.amazonses.com", "SES_EVENT");
    await processSesEvent(jsonFixture("ses-delivery.json"), deps());
    expect(await pending()).toBeDefined();
    await processSesEvent(jsonFixture("ses-complaint.json"), deps());
    expect(world.sink.events.map((event) => (event.type === "EMAIL_EVENT" ? event.sesEventType : event.type))).toEqual(["DELIVERY", "COMPLAINT"]);
    expect(await pending()).toBeUndefined();
    expect(await probe()).toMatchObject({ outcome: "SES_EVENT", reason: "COMPLAINT" });
  });

  it("[FL-031] apply_email_event: contact COMPLAINED, escalation NO_VALID_CONTACT, no AGENT_TURN", () => {
    const plan = planEmailEvent({ type: "COMPLAINT", message, atSim: SIM_NOW });
    expect(plan).toEqual({ messageStatus: "COMPLAINED", contactStatus: "COMPLAINED", escalation: "NO_VALID_CONTACT", alarm: false });
    expect(plan.turn).toBeUndefined();
    expect(planEmailEvent({ type: "DELIVERY", message: { ...message, status: "COMPLAINED" }, atSim: SIM_NOW })).toEqual({ alarm: false });
  });
});

describe("other SES events", () => {
  it("never closes a pending mail that waits for SimMail: a delivery to a sim mailbox only updates the message", async () => {
    await seedSent("supplier-qingdao@sim.legajo.demo.craftech.io", "SIMMAIL");
    const delivered = jsonFixture<{ detail: { delivery: { recipients: string[] } } }>("ses-delivery.json");
    delivered.detail.delivery.recipients = ["supplier-qingdao@sim.legajo.demo.craftech.io"];
    await processSesEvent(delivered, deps());
    expect(world.sink.events).toHaveLength(1);
    expect(await pending()).toBeDefined();
  });

  it("marks rejections and rendering failures FAILED with the error alarm, and delays DELIVERED", () => {
    expect(planEmailEvent({ type: "REJECT", message, atSim: SIM_NOW })).toEqual({ messageStatus: "FAILED", alarm: true });
    expect(planEmailEvent({ type: "RENDERING_FAILURE", message, atSim: SIM_NOW })).toEqual({ messageStatus: "FAILED", alarm: true });
    expect(planEmailEvent({ type: "DELIVERY_DELAY", message, atSim: SIM_NOW })).toEqual({ messageStatus: "DELAYED", alarm: false });
    expect(planEmailEvent({ type: "DELIVERY", message, atSim: SIM_NOW })).toEqual({ messageStatus: "DELIVERED", alarm: false });
    expect(parseSesEvent(jsonFixture("ses-reject.json"))).toMatchObject({ type: "REJECT", recipients: ["supplier-qingdao@sim.legajo.demo.craftech.io"] });
  });

  it("ignores opens, mail that is not ours, and retries an event whose message is not recorded yet", async () => {
    expect(await processSesEvent(jsonFixture("ses-open.json"), deps())).toBe("IGNORED");
    const tagged = jsonFixture("ses-bounce-permanent.json");
    await expect(processSesEvent(tagged, deps())).rejects.toBeInstanceOf(ChannelError);
    const untagged = jsonFixture<{ detail: { mail: { tags: Record<string, string[]> } } }>("ses-bounce-permanent.json");
    delete untagged.detail.mail.tags.messageId;
    expect(await processSesEvent(untagged, deps())).toBe("IGNORED");
    expect(world.sink.events).toEqual([]);
    await expect(processSesEvent({ source: "aws.s3" }, deps())).rejects.toThrow();
  });
});
