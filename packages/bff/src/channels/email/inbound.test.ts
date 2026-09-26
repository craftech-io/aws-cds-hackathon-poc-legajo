import { beforeEach, describe, expect, it } from "vitest";
import { computeThreadTag, threadAddress } from "@legajo/shared";
import { hashOf, operationFixture } from "../../connector/testing";
import { receiveInboundEmail } from "./inbound";
import { inboundMessageId } from "./inbound-record";
import {
  ANSWERED_SES_ID,
  CLOCK,
  type EmailWorld,
  QINGDAO,
  QINGDAO_PENDING,
  REAL_NOW,
  REPLY_MAIL_ID,
  SANTOSVERDE,
  TEST_THREAD_KEY,
  deliver,
  emailWorld,
  fixture,
  inboundDeps,
  mime,
  receiptEvent,
  seedAnsweredRequest,
  seedPending,
} from "./testing";

let world: EmailWorld;
const INJECTOR = "qainject-812-1-sc15@sim.legajo.demo.craftech.io";

beforeEach(async () => {
  world = await emailWorld();
});

async function receive(sesMessageId: string, raw: Uint8Array | undefined, options: Omit<Parameters<typeof receiptEvent>[0], "sesMessageId" | "recipient"> & { readonly recipient?: string } = {}) {
  if (raw !== undefined) deliver(world, sesMessageId, raw);
  const event = receiptEvent({ sesMessageId, recipient: options.recipient ?? world.op4471.threadAddress, ...options });
  return receiveInboundEmail(event, inboundDeps(world));
}

const messages = () => world.stores.connector.conversations.listMessages(world.op4471.operationId, { direction: "IN" });
const probe = (mailId: string) => world.stores.connector.runtime.getMailProbe(mailId);
const pending = (mailId: string) => world.stores.connector.world.getMailPending(CLOCK, mailId);
const trail = () => world.stores.connector.audit.listByOperation(world.op4471.operationId);
const metricLines = () => world.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.metric === "ThreadAddressInvalid");

describe("[FL-021] a trusted reply of the supplier with its PDFs", () => {
  it("[FL-021] records a trusted message, enqueues one intake per PDF and then the SUPPLIER_EMAIL turn, and closes the pending mail", async () => {
    await seedAnsweredRequest(world);
    await seedPending(world, { mailId: REPLY_MAIL_ID, from: QINGDAO });
    const result = await receive("ses-reply-1", fixture("reply.eml"), { rfcMessageId: "<reply-4471-1@sim.legajo.demo.craftech.io>" });

    expect(result).toEqual({ outcome: "ENQUEUED", operationId: "op-4471", messageId: inboundMessageId("ses-reply-1") });
    const [message] = await messages();
    expect(message).toMatchObject({ trusted: true, status: "RECEIVED", contactId: "ctc-qingdao-1", from: QINGDAO, to: world.op4471.threadAddress, author: "SUPPLIER", sentAtSim: "2026-10-15T22:10:00.000Z" });
    expect(message?.rfcMessageId).toBe("<reply-4471-1@sim.legajo.demo.craftech.io>");
    expect(message?.inReplyTo).toBe(`<${ANSWERED_SES_ID}@email.amazonses.com>`);
    expect(message?.body).toContain("Please find attached the packing list and certificate of origin");
    expect(message?.body).not.toContain("We are still missing");
    expect(message?.attachments.map((attachment) => [attachment.status, attachment.reason])).toEqual([["ACCEPTED", undefined], ["ACCEPTED", undefined], ["REJECTED", "NOT_PDF"]]);

    const types = world.sink.events.map((event) => event.type);
    expect(types).toEqual(["INTAKE_DOCUMENT", "INTAKE_DOCUMENT", "AGENT_TURN"]);
    const [first, second, turn] = world.sink.events;
    expect(first).toMatchObject({ source: { party: "SUPPLIER", channel: "EMAIL", messageId: message?.messageId, contactId: "ctc-qingdao-1" }, object: { store: "INBOUND_MAIL", key: "poc/ops/ses-reply-1", attachmentIndex: 0 } });
    expect(second).toMatchObject({ object: { attachmentIndex: 1 } });
    expect(turn).toMatchObject({ trigger: "SUPPLIER_EMAIL", messageId: message?.messageId, inReplyToMessageId: "msg-4471out1", intakeEventIds: [first?.eventId, second?.eventId] });
    expect((await world.stores.connector.world.getOpState("op-4471"))?.inFlight).toHaveLength(3);

    expect(await probe(REPLY_MAIL_ID)).toMatchObject({ outcome: "ENQUEUED", operationId: "op-4471", clockId: CLOCK });
    expect(await pending(REPLY_MAIL_ID)).toBeUndefined();
  });
});

describe("[FL-034] a redelivered email is processed once", () => {
  it("[FL-034] the same SES message id and the same Message-ID give one record, one intake set and one turn", async () => {
    const first = await receive("ses-dup-1", fixture("reply.eml"), { rfcMessageId: "<reply-4471-1@sim.legajo.demo.craftech.io>" });
    const again = await receive("ses-dup-1", undefined, { rfcMessageId: "<reply-4471-1@sim.legajo.demo.craftech.io>" });
    const resent = await receive("ses-dup-2", fixture("reply.eml"), { rfcMessageId: "<reply-4471-1@sim.legajo.demo.craftech.io>" });

    expect(first.outcome).toBe("ENQUEUED");
    expect(again).toEqual({ outcome: "DUPLICATE", operationId: "op-4471", messageId: first.messageId });
    expect(resent.outcome).toBe("DUPLICATE");
    expect(await messages()).toHaveLength(1);
    expect(world.sink.events.map((event) => event.type)).toEqual(["INTAKE_DOCUMENT", "INTAKE_DOCUMENT", "AGENT_TURN"]);
    expect((await trail()).filter((row) => row.action === "EMAIL_DUPLICATE_IGNORED")).toHaveLength(2);
  });

  it("[FL-034] a forged mail that reuses the Message-ID first never turns the genuine one into a duplicate", async () => {
    const rfcMessageId = "<reply-4471-1@sim.legajo.demo.craftech.io>";
    const forged = await receive("ses-forged-first", fixture("spoofed.eml"), { rfcMessageId, verdicts: { dmarcVerdict: "FAIL" } });
    const genuine = await receive("ses-genuine-after", fixture("reply.eml"), { rfcMessageId });
    expect(forged.outcome).toBe("QUARANTINED");
    expect(genuine.outcome).toBe("ENQUEUED");
  });

  it("[FL-034] derives the same event ids from the same Message-ID, so the queue drops a replay", async () => {
    await receive("ses-id-1", fixture("reply.eml"), { rfcMessageId: "<reply-4471-1@sim.legajo.demo.craftech.io>" });
    const ids = world.sink.events.map((event) => event.eventId);
    const other = await emailWorld();
    deliver(other, "ses-id-9", fixture("reply.eml"));
    await receiveInboundEmail(receiptEvent({ sesMessageId: "ses-id-9", recipient: other.op4471.threadAddress, rfcMessageId: "<reply-4471-1@sim.legajo.demo.craftech.io>" }), inboundDeps(other));
    expect(other.sink.events.map((event) => event.eventId)).toEqual(ids);
  });
});

describe("[FL-032] automatic replies never produce a turn", () => {
  it("[FL-032] auto-reply.eml is recorded as ignored, audited and closes its pending mail with AUTO_REPLY_IGNORED", async () => {
    await seedPending(world, { mailId: "01JQ7ZK8X4M2N6P9R3T5V7W9Y2", from: "supplier-ningbo@sim.legajo.demo.craftech.io" });
    const result = await receive("ses-auto-1", fixture("auto-reply.eml"), {
      fromHeader: "\"Ningbo Harborlight Lamps Co.\" <supplier-ningbo@sim.legajo.demo.craftech.io>",
      mailIdHeader: "01JQ7ZK8X4M2N6P9R3T5V7W9Y2; clock=GLOBAL#firm-delta",
    });
    expect(result).toMatchObject({ outcome: "AUTO_REPLY_IGNORED", reason: "AUTO_REPLY_IGNORED" });
    expect(world.sink.events).toEqual([]);
    expect((await messages())[0]).toMatchObject({ status: "DISCARDED", trusted: false });
    expect((await trail()).map((row) => [row.decision, row.action])).toContainEqual(["ACTION", "AUTO_REPLY_IGNORED"]);
    expect(await probe("01JQ7ZK8X4M2N6P9R3T5V7W9Y2")).toMatchObject({ outcome: "AUTO_REPLY_IGNORED", reason: "AUTO_REPLY_IGNORED" });
  });

  it.each([
    ["Precedence: bulk", { from: `Qingdao <${QINGDAO}>`, headers: ["Precedence: bulk"] }],
    ["X-Autoreply", { from: `Qingdao <${QINGDAO}>`, headers: ["X-Autoreply: yes"] }],
    ["a mailer-daemon sender", { from: "MAILER-DAEMON@sim.legajo.demo.craftech.io" }],
    ["a no-reply sender", { from: "no-reply@sim.legajo.demo.craftech.io" }],
    ["a sender in the thread domain", { from: "op-4483-abcdef@legajo.demo.craftech.io" }],
  ])("[FL-032] %s is ignored as automatic, even from a registered contact", async (_label, options) => {
    const result = await receive(`ses-auto-${_label.length}`, mime({ ...options, messageId: `<auto-${_label.length}@x.sim.legajo.demo.craftech.io>`, pdfs: 1 }));
    expect(result.outcome).toBe("AUTO_REPLY_IGNORED");
    expect(world.sink.events).toEqual([]);
  });
});

describe("[FL-035] a sender that is not an ACTIVE contact of this operation's supplier", () => {
  it.each([
    ["an unregistered mailbox (the QA injector)", INJECTOR],
    ["a PENDING_CONFIRMATION contact (pending-contact.eml)", QINGDAO_PENDING],
    ["an ACTIVE contact of another supplier", SANTOSVERDE],
  ])("[FL-035] %s is quarantined and escalated, with no turn and no reply", async (_label, from) => {
    const raw = from === QINGDAO_PENDING ? fixture("pending-contact.eml") : mime({ from, messageId: `<untrusted-${from.length}@sim.legajo.demo.craftech.io>`, pdfs: 1 });
    await seedPending(world, { mailId: "qa0123456789abcdef0123456789abcdef01234567", from });
    const result = await receive(`ses-untrusted-${from.length}`, raw, { fromHeader: from, mailIdHeader: "qa0123456789abcdef0123456789abcdef01234567; clock=GLOBAL#firm-delta" });

    expect(result).toMatchObject({ outcome: "QUARANTINED", reason: "UNTRUSTED_SENDER" });
    const [message] = await messages();
    expect(message).toMatchObject({ trusted: false, status: "QUARANTINED" });
    expect(message?.attachments).toHaveLength(1);
    expect(message?.attachments[0]).toMatchObject({ status: "QUARANTINED", s3Key: `quarantine/op-4471/${message?.messageId}/0.pdf` });
    expect([...world.mailStore.quarantined.keys()]).toEqual([`quarantine/op-4471/${message?.messageId}/0.pdf`]);
    expect(world.sink.events).toHaveLength(1);
    expect(world.sink.events[0]).toMatchObject({ type: "ESCALATE", reason: "UNTRUSTED_SENDER", messageId: message?.messageId });
    expect((await trail()).map((row) => [row.decision, row.action])).toContainEqual(["DENY", "UNTRUSTED_SENDER"]);
    expect(await probe("qa0123456789abcdef0123456789abcdef01234567")).toMatchObject({ outcome: "QUARANTINED", reason: "UNTRUSTED_SENDER" });
  });

  it("[FL-035] every untrusted mail asks the worker for its own escalation (the worker caps the emails to the firm per day)", async () => {
    for (const index of [1, 2, 3, 4]) {
      const messageId = `<flood-${index}@sim.legajo.demo.craftech.io>`;
      await receive(`ses-flood-${index}`, mime({ from: INJECTOR, messageId }), { fromHeader: INJECTOR, rfcMessageId: messageId });
    }
    const escalations = world.sink.events.filter((event) => event.type === "ESCALATE");
    expect(escalations).toHaveLength(4);
    expect(new Set(escalations.map((event) => event.eventId)).size).toBe(4);
    expect(world.sink.events.some((event) => event.type === "AGENT_TURN" || event.type === "INTAKE_DOCUMENT")).toBe(false);
  });
});

describe("[FL-036] trust is dmarcVerdict PASS and nothing else", () => {
  it.each([
    ["spoofed.eml", "spoofed.eml", { dmarcVerdict: "FAIL" }],
    ["spoofed-dual-dkim.eml (a valid DKIM signature of another domain, a forged aligned one)", "spoofed-dual-dkim.eml", { dkimVerdict: "PASS", spfVerdict: "PASS", dmarcVerdict: "FAIL" }],
    ["dmarc-gray.eml", "dmarc-gray.eml", { dmarcVerdict: "GRAY" }],
    ["dmarc-gray.eml with PROCESSING_FAILED", "dmarc-gray.eml", { dmarcVerdict: "PROCESSING_FAILED" }],
  ])("[FL-036] %s from an ACTIVE contact ends in quarantine with UNTRUSTED_SENDER", async (_label, name, verdicts) => {
    const result = await receive(`ses-${name.length}-${verdicts.dmarcVerdict}`, fixture(name), { verdicts });
    expect(result).toMatchObject({ outcome: "QUARANTINED", reason: "UNTRUSTED_SENDER" });
    expect((await messages())[0]).toMatchObject({ trusted: false, contactId: "ctc-qingdao-1" });
    expect(world.sink.events.map((event) => [event.type, event.type === "ESCALATE" ? event.reason : undefined])).toEqual([["ESCALATE", "UNTRUSTED_SENDER"]]);
  });

  it("[FL-036] the dual-DKIM fixture carries an aligned d= that is never read", () => {
    const raw = new TextDecoder().decode(fixture("spoofed-dual-dkim.eml"));
    expect(raw).toContain("d=sim.legajo.demo.craftech.io");
    expect(raw).toContain("d=attacker.example.net");
  });

  it.each([["spamVerdict"], ["virusVerdict"]] as const)("[FL-036] %s FAIL is an audited discard before any record or quarantine", async (verdict) => {
    const result = await receive(`ses-${verdict}`, undefined, { verdicts: { [verdict]: "FAIL" } });
    expect(result).toEqual({ outcome: "DISCARDED", reason: verdict === "spamVerdict" ? "SPAM_VERDICT" : "VIRUS_VERDICT", operationId: "op-4471" });
    expect(await messages()).toEqual([]);
    expect(world.sink.events).toEqual([]);
    expect(world.mailStore.quarantined.size).toBe(0);
    expect((await trail()).map((row) => [row.decision, row.action])).toEqual([["DENY", "EMAIL_DISCARDED"]]);
  });
});

describe("[FL-037] an address of another operation, of none, or of a past epoch", () => {
  it("[FL-037] discards a tag that does not resolve (THREAD_ADDRESS_INVALID) and closes our own mail's pending item", async () => {
    await seedPending(world, { mailId: "qa0123456789abcdef0123456789abcdef0123aaaa", from: INJECTOR, to: "op-4471-zzzzzz@legajo.demo.craftech.io" });
    const result = await receive("ses-bad-tag", undefined, { recipient: "op-4471-zzzzzz@legajo.demo.craftech.io", fromHeader: INJECTOR, mailIdHeader: "qa0123456789abcdef0123456789abcdef0123aaaa; clock=GLOBAL#firm-delta" });
    expect(result).toEqual({ outcome: "DISCARDED", reason: "THREAD_ADDRESS_INVALID" });
    expect(await probe("qa0123456789abcdef0123456789abcdef0123aaaa")).toMatchObject({ outcome: "DISCARDED", reason: "THREAD_ADDRESS_INVALID" });
    expect(metricLines()).toHaveLength(1);
    expect(await trail()).toEqual([]);
  });

  it("[FL-037] discards a number that holds no operation (THREAD_ADDRESS_UNKNOWN) without reading the mail", async () => {
    expect(await receive("ses-unknown", undefined, { recipient: "op-9999-abcdef@legajo.demo.craftech.io" })).toEqual({ outcome: "DISCARDED", reason: "THREAD_ADDRESS_UNKNOWN" });
    expect(await receive("ses-zero", undefined, { recipient: "op-0000-q7p2q9@legajo.demo.craftech.io" })).toEqual({ outcome: "DISCARDED", reason: "THREAD_ADDRESS_UNKNOWN" });
    expect(await receive("ses-qa-free", undefined, { recipient: "op-7042-abcdef@legajo.demo.craftech.io" })).toEqual({ outcome: "DISCARDED", reason: "THREAD_ADDRESS_UNKNOWN" });
    await world.stores.connector.world.acquireLease({ kind: "OPNUM", value: "7042", holder: "qa-812-1-sc15", atReal: REAL_NOW });
    expect(await receive("ses-qa-leased", undefined, { recipient: "op-7042-abcdef@legajo.demo.craftech.io" })).toEqual({ outcome: "DISCARDED", reason: "THREAD_ADDRESS_INVALID" });
    expect(metricLines()).toHaveLength(4);
    expect(world.sink.events).toEqual([]);
  });

  it("[FL-037] discards an address of a tombstoned epoch (TOMBSTONED)", async () => {
    await world.stores.connector.world.putTombstone({ clockId: CLOCK, worldEpoch: 1, atReal: REAL_NOW });
    expect(await receive("ses-tomb", undefined)).toEqual({ outcome: "DISCARDED", reason: "TOMBSTONED" });
  });

  it("[FL-037] refuses a thread row whose tag does not verify by HMAC, and a mail to two threads", async () => {
    const forgedTag = await computeThreadTag(new TextEncoder().encode("another-key-another-key-another!!"), { operationNumber: "4490", clockId: CLOCK, worldEpoch: 1 });
    const forged = threadAddress("4490", forgedTag);
    await world.stores.connector.operations.createOperation({ ...operationFixture({ operationNumber: "4490", threadTag: forgedTag, threadAddress: forged }), threadClaimHash: hashOf(forged) });
    expect(await receive("ses-forged", undefined, { recipient: forged })).toEqual({ outcome: "DISCARDED", reason: "THREAD_ADDRESS_INVALID" });
    const both = receiptEvent({ sesMessageId: "ses-two", recipient: world.op4471.threadAddress });
    (both as { Records: Array<{ ses: { receipt: { recipients: string[] } } }> }).Records[0]!.ses.receipt.recipients.push(world.op4483.threadAddress);
    expect(await receiveInboundEmail(both, inboundDeps(world))).toEqual({ outcome: "DISCARDED", reason: "THREAD_ADDRESS_INVALID" });
  });

  it("[FL-037] the supplier of another operation writing to this thread is quarantined here, and nothing reaches the other operation", async () => {
    await receive("ses-cross", mime({ from: SANTOSVERDE, messageId: "<cross-1@sim.legajo.demo.craftech.io>", pdfs: 1 }), { fromHeader: SANTOSVERDE });
    expect((await messages())[0]).toMatchObject({ trusted: false, status: "QUARANTINED" });
    expect(await world.stores.connector.conversations.listMessages(world.op4483.operationId)).toEqual([]);
    expect(world.sink.events.every((event) => event.operationId === "op-4471")).toBe(true);
  });

  it("[FL-037] writes PROBE#MAIL# only for our own mail with an open pending item of the same From", async () => {
    await seedPending(world, { mailId: "qa0123456789abcdef0123456789abcdef0123bbbb", from: INJECTOR, to: "op-9999-abcdef@legajo.demo.craftech.io" });
    const header = "qa0123456789abcdef0123456789abcdef0123bbbb; clock=GLOBAL#firm-delta";
    await receive("ses-not-dmarc", undefined, { recipient: "op-9999-abcdef@legajo.demo.craftech.io", fromHeader: INJECTOR, mailIdHeader: header, verdicts: { dmarcVerdict: "FAIL" } });
    await receive("ses-other-domain", undefined, { recipient: "op-9999-abcdef@legajo.demo.craftech.io", fromHeader: "someone@mail.attacker.example.net", mailIdHeader: header });
    await receive("ses-other-from", undefined, { recipient: "op-9999-abcdef@legajo.demo.craftech.io", fromHeader: QINGDAO, mailIdHeader: header });
    expect(await probe("qa0123456789abcdef0123456789abcdef0123bbbb")).toBeUndefined();
    expect(await pending("qa0123456789abcdef0123456789abcdef0123bbbb")).toBeDefined();
    await receive("ses-ours", undefined, { recipient: "op-9999-abcdef@legajo.demo.craftech.io", fromHeader: INJECTOR, mailIdHeader: header });
    expect(await probe("qa0123456789abcdef0123456789abcdef0123bbbb")).toMatchObject({ outcome: "DISCARDED", reason: "THREAD_ADDRESS_UNKNOWN" });
    expect(await pending("qa0123456789abcdef0123456789abcdef0123bbbb")).toBeUndefined();
  });
});

describe("thread keys", () => {
  it("verifies the fixture world's tags with the test key only", async () => {
    expect(world.op4471.threadTag).toBe(await computeThreadTag(TEST_THREAD_KEY, { operationNumber: "4471", clockId: CLOCK, worldEpoch: 1 }));
  });
});
