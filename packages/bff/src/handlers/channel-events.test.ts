import { beforeEach, describe, expect, it } from "vitest";
import { stageChannelEventsDeps } from "../channels/email/adapter";
import { readMailStatus } from "../channels/email/mail-status";
import { CLOCK, type EmailWorld, FIRM, REAL_NOW, SIM_NOW, emailWorld, jsonFixture } from "../channels/email/testing";
import { leadEmailHash } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { LEADS_TABLE } from "../leads/lead";
import { testSignupKeys } from "../signup/testing";
import { type ChannelEventsEntryDeps, createChannelEventsHandler } from "./channel-events";

const SES_ID = "0100019a2b3c4d5e-6f708192-a3b4-45c6-97d8-e9fa0b1c2d3e-000000";
const MAIL_ID = "01JQ7ZK8X4M2N6P9R3T5V7W9Z1";
const ACCOUNT_ADDRESS = "nadie@despachos-del-sur.com.ar";
const keys = testSignupKeys();

let world: EmailWorld;
let lines: string[];

beforeEach(async () => {
  world = await emailWorld();
  lines = [];
});

function handler() {
  const log = createLogger({ level: "debug", sink: (line) => lines.push(line), now: () => new Date(REAL_NOW) });
  return createChannelEventsHandler((): ChannelEventsEntryDeps => {
    return {
      channel: { ...stageChannelEventsDeps({ log, events: world.sink, data: world.stores.connector }), pending: { world: world.stores.connector.world, runtime: world.stores.connector.runtime, now: () => new Date(REAL_NOW) } },
      mailStatus: { client: world.stores.client, leadEmailKey: keys.leadEmail, log, now: () => new Date(REAL_NOW) },
    };
  }, () => log);
}

type SesFixture = { detail: { mail: { messageId: string; destination: string[]; tags: Record<string, string[]> }; bounce?: { bounceType: string; bouncedRecipients: Array<{ emailAddress: string }> }; complaint?: { complainedRecipients: Array<{ emailAddress: string }> } } };

/** The same SES event for an account email of Cognito: no `messageId` tag and no `Message OUT`. */
function accountMailEvent(name: string, bounceType?: "Permanent" | "Transient"): unknown {
  const event = jsonFixture<SesFixture>(name);
  const { detail } = event;
  detail.mail.messageId = "0100019a-account-mail-000001";
  detail.mail.destination = [ACCOUNT_ADDRESS];
  detail.mail.tags = { "ses:configuration-set": ["aws-cds-hackathon-poc-legajo-email-poc"] };
  if (detail.bounce !== undefined) {
    detail.bounce.bouncedRecipients = [{ emailAddress: ACCOUNT_ADDRESS }];
    if (bounceType !== undefined) detail.bounce.bounceType = bounceType;
  }
  if (detail.complaint !== undefined) detail.complaint.complainedRecipients = [{ emailAddress: ACCOUNT_ADDRESS }];
  return event;
}

const statusOf = (address: string) => readMailStatus(world.stores.client, leadEmailHash(keys.leadEmail, address));

describe("ChannelEvents: mails of an operation", () => {
  it("[FL-029] a permanent bounce of a recorded mail enqueues EMAIL_EVENT and closes its SES_EVENT pending mail", async () => {
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
      to: "bounce@simulator.amazonses.com",
      from: world.op4471.threadAddress,
      body: "Hello, we still need the packing list.",
      status: "SENT",
      author: "AGENT",
      sentAtSim: SIM_NOW,
      sentAtReal: REAL_NOW,
      providerMessageId: SES_ID,
      mailId: MAIL_ID,
    });
    await state.putMailPending({ clockId: CLOCK, mailId: MAIL_ID, from: world.op4471.threadAddress, to: "bounce@simulator.amazonses.com", profile: "SYSTEM", awaiting: "SES_EVENT", sentAtReal: REAL_NOW, operationId: world.op4471.operationId });

    expect(await handler()(jsonFixture("ses-bounce-permanent.json"))).toEqual({ status: "ENQUEUED" });
    expect(world.sink.events.map((event) => event.type)).toEqual(["EMAIL_EVENT"]);
    expect(await state.getMailPending(CLOCK, MAIL_ID)).toBeUndefined();
    expect(await statusOf("bounce@simulator.amazonses.com")).toBeUndefined();
  });

  it("a tagged mail not recorded yet throws, so EventBridge delivers the event again", async () => {
    await expect(handler()(jsonFixture("ses-bounce-permanent.json"))).rejects.toThrow();
    expect(world.sink.events).toEqual([]);
  });
});

describe("ChannelEvents: account emails and the lead notice (markMailStatus)", () => {
  it("a permanent bounce marks MAILSTATUS# BOUNCED with the lead-email hash, without the address in any log and without Leads", async () => {
    expect(await handler()(accountMailEvent("ses-bounce-permanent.json"))).toEqual({ status: "ACCOUNT_MAIL_MARKED" });
    expect(await statusOf(ACCOUNT_ADDRESS)).toMatchObject({ status: "BOUNCED", count: 1 });
    expect(world.sink.events).toEqual([]);
    expect(world.stores.client.dump(LEADS_TABLE)).toEqual([]);
    const logged = lines.join("\n");
    expect(logged).not.toContain(ACCOUNT_ADDRESS);
    expect(logged).not.toContain(leadEmailHash(keys.leadEmail, ACCOUNT_ADDRESS));
    expect(logged).toContain('"metric":"AccountMailStatusMarked"');
  });

  it("a complaint marks COMPLAINED", async () => {
    expect(await handler()(accountMailEvent("ses-complaint.json"))).toEqual({ status: "ACCOUNT_MAIL_MARKED" });
    expect(await statusOf(ACCOUNT_ADDRESS)).toMatchObject({ status: "COMPLAINED" });
  });

  it("a transient bounce or a delivery of an account email marks nothing", async () => {
    expect(await handler()(accountMailEvent("ses-bounce-transient.json", "Transient"))).toEqual({ status: "ACCOUNT_MAIL_IGNORED" });
    expect(await handler()(accountMailEvent("ses-delivery.json"))).toEqual({ status: "ACCOUNT_MAIL_IGNORED" });
    expect(await statusOf(ACCOUNT_ADDRESS)).toBeUndefined();
  });

  it("an event that does not parse is dropped; an untracked type (Open) is ignored", async () => {
    expect(await handler()({ source: "aws.ses", detail: {} })).toEqual({ status: "INVALID" });
    expect(lines.some((line) => line.includes("channel_events.invalid_event"))).toBe(true);
    expect(await handler()(jsonFixture("ses-open.json"))).toEqual({ status: "IGNORED" });
  });
});
