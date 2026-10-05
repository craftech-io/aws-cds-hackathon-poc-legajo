import { SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { describe, expect, it } from "vitest";
import { processWhatsAppEvent } from "./inbound";
import { WhatsAppSnsEvent } from "./payloads";
import { checkEnvelope, createWhatsAppTransport } from "./registry";
import { KEYS, PHONE, TOPIC_ARN, type WaWorld, liveEvent, simEvent, waWorld } from "./testing";

const EXPECT = { topicArn: TOPIC_ARN, accountId: "776805327629", simEnvelopeKey: KEYS.simEnvelope };

function recordOf(event: unknown) {
  const record = WhatsAppSnsEvent.parse(event).Records[0];
  if (record === undefined) throw new Error("no record");
  return record;
}

async function nothingWritten(world: WaWorld) {
  expect(await world.stores.connector.conversations.listMessages("op-4471")).toEqual([]);
  expect(world.events).toEqual([]);
}

describe("[FL-100] the mode of WhatsApp decides which envelopes enter", () => {
  it("[FL-100] a live stage keeps the phone simulator: a signed simulated envelope enters, an unsigned one is refused", async () => {
    const signed = recordOf(simEvent({ type: "text", text: "Hola" }));
    expect(checkEnvelope(signed, { mode: "live", ...EXPECT })).toMatchObject({ accepted: true, simulated: true });
    const unsigned = { ...signed, Sns: { ...signed.Sns, MessageAttributes: {} } };
    expect(checkEnvelope(unsigned, { mode: "live", ...EXPECT })).toMatchObject({ accepted: false, simulated: true, reason: "BAD_SIGNATURE" });
    const world = await waWorld({ mode: "live" });
    await processWhatsAppEvent({ Records: [unsigned] }, world.deps);
    await nothingWritten(world);
  });

  it("[FL-100] a simulated envelope needs the signature of its own body", async () => {
    const world = await waWorld();
    const signed = recordOf(simEvent({ type: "text", text: "Hola" }));
    expect(checkEnvelope(signed, { mode: "simulated", ...EXPECT }).accepted).toBe(true);
    const tampered = { ...signed, Sns: { ...signed.Sns, Message: signed.Sns.Message.replace("Hola", "Chau") } };
    expect(checkEnvelope(tampered, { mode: "simulated", ...EXPECT })).toMatchObject({ accepted: false, reason: "BAD_SIGNATURE" });
    const unsigned = { ...signed, Sns: { ...signed.Sns, MessageAttributes: {} } };
    expect(checkEnvelope(unsigned, { mode: "simulated", ...EXPECT })).toMatchObject({ accepted: false, reason: "BAD_SIGNATURE" });
    const otherKey = { ...EXPECT, simEnvelopeKey: KEYS.nonce };
    expect(checkEnvelope(signed, { mode: "simulated", ...otherKey })).toMatchObject({ accepted: false, reason: "BAD_SIGNATURE" });
    await processWhatsAppEvent({ Records: [tampered] }, world.deps);
    await nothingWritten(world);
  });

  it("[FL-100] a live envelope enters in either mode only from the stage's topic, by SNS, for this account", async () => {
    const live = recordOf(liveEvent("sns-text.json", { TEXT: "Hola" }));
    expect(checkEnvelope(live, { mode: "simulated", ...EXPECT })).toMatchObject({ accepted: true, simulated: false });
    expect(checkEnvelope(live, { mode: "live", ...EXPECT })).toMatchObject({ accepted: true, simulated: false });
    const otherTopic = { ...live, Sns: { ...live.Sns, TopicArn: "arn:aws:sns:us-east-1:776805327629:another-topic" } };
    expect(checkEnvelope(otherTopic, { mode: "simulated", ...EXPECT })).toMatchObject({ accepted: false, reason: "NOT_FROM_TOPIC" });
    const invoked = { ...live, EventSource: "aws:lambda" };
    expect(checkEnvelope(invoked, { mode: "live", ...EXPECT })).toMatchObject({ accepted: false, reason: "NOT_FROM_TOPIC" });
    const otherAccount = { ...live, Sns: { ...live.Sns, Message: live.Sns.Message.replace('"aws_account_id":"776805327629"', '"aws_account_id":"111122223333"') } };
    expect(checkEnvelope(otherAccount, { mode: "live", ...EXPECT })).toMatchObject({ accepted: false, reason: "FOREIGN_ACCOUNT" });
  });

  it("[FL-100] a record from the topic carrying a simulated message id is still a simulated envelope and needs the signature", async () => {
    const forged = recordOf(liveEvent("sns-text.json", { TEXT: "Hola", WAMID: "wamid.SIM.FORGED0000000000000000000" }));
    expect(checkEnvelope(forged, { mode: "simulated", ...EXPECT })).toMatchObject({ accepted: false, simulated: true, reason: "BAD_SIGNATURE" });
    expect(checkEnvelope(forged, { mode: "live", ...EXPECT })).toMatchObject({ accepted: false, simulated: true, reason: "BAD_SIGNATURE" });
  });

  it("[FL-100] a malformed body or event is refused without being processed", async () => {
    const world = await waWorld();
    const live = recordOf(liveEvent("sns-text.json", { TEXT: "Hola" }));
    const broken = { ...live, Sns: { ...live.Sns, Message: '{"context":{},"whatsAppWebhookEntry":"{not json"' } };
    expect(checkEnvelope(broken, { mode: "simulated", ...EXPECT })).toMatchObject({ accepted: false, reason: "INVALID_PAYLOAD" });
    expect((await processWhatsAppEvent({ Records: "nope" }, world.deps)).records).toMatchObject([{ accepted: false, reason: "INVALID_EVENT" }]);
    await nothingWritten(world);
  });
});

describe("[FL-100] the transport of the mode", () => {
  it("[FL-100] simulated mode builds the simulated transport; live needs the connection of P-01", async () => {
    const world = await waWorld();
    const simulated = { conversations: world.stores.connector.conversations, templates: world.stores.connector.reference, media: world.media, realClock: world.deps.realClock, log: world.deps.log };
    expect(createWhatsAppTransport("simulated", { simulated }).mode).toBe("simulated");
    expect(() => createWhatsAppTransport("live", { simulated })).toThrow(/connection/);
    const live = createWhatsAppTransport("live", {
      simulated,
      live: () => ({ phoneNumberId: "phone-number-id-0123456789abcdef0123456789abcdef", mediaBucket: "media", allowedPhones: [PHONE], templates: world.stores.connector.reference, media: world.media, realClock: world.deps.realClock, client: new SocialMessagingClient({ region: "us-east-1" }) }),
    });
    expect(live.mode).toBe("live");
  });
});
