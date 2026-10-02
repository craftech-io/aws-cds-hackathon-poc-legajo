import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { receiveSimMail } from "./receive";
import { CLOCK, FIRM, FIRM_MAILBOX, INJECTOR, QINGDAO, REAL_NOW, SANTOSVERDE, SIGNUP_MAILBOX, type SimWorld, deliverSim, mailboxOf, metricLines, pendingOf, probeOf, recordOutbound, simTimers, simWorld } from "./testing";

const ses = mockClient(SESv2Client);
const OUT_ID = "0100019a2b3c4d5e-out-req-0001";
const RFC_ID = `<${OUT_ID}@email.amazonses.com>`;
const MAIL_ID = "01JQREQUESTMAIL00000000001";

let world: SimWorld;
let thread: string;

beforeEach(async () => {
  ses.reset();
  ses.on(SendEmailCommand).resolves({ MessageId: "0100019a2b3c4d5e-sim-reply-0001" });
  world = await simWorld();
  thread = world.email.op4471.threadAddress;
  await recordOutbound(world, { messageId: "msg-4471out1", providerMessageId: OUT_ID, to: QINGDAO, mailId: MAIL_ID });
});

const fromThread = () => `"Estudio Delta via Legajo listo" <${thread}>`;
const untrustedAudit = async () => (await world.email.stores.connector.audit.listByDecision(FIRM, "DENY")).filter((row) => row.action === "SIM_UNTRUSTED");

/** Nothing of the simulator happened: no reply, no mailbox row, no timer. */
async function expectNoEffect(mailbox = QINGDAO): Promise<void> {
  expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  expect(await mailboxOf(world, mailbox)).toEqual([]);
  expect(await simTimers(world)).toEqual([]);
}

describe("[FL-088] SimMail acts only on mail we sent: SIM_UNTRUSTED before anything else", () => {
  it("[FL-088] a dmarcVerdict other than PASS is discarded: metric, one audit row for the mailbox's firm, the pending left alone (nothing proves it ours)", async () => {
    const event = deliverSim(world, { sesMessageId: "ses-in-dmarc", recipient: QINGDAO, from: fromThread(), rfcMessageId: RFC_ID, mailIdHeader: `${MAIL_ID}; clock=${CLOCK}`, dmarc: "FAIL", operationNumber: "4471", request: "kind=DOCS_REQUEST; docs=PACKING_LIST" });
    expect(await receiveSimMail(event, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "DMARC" });
    await expectNoEffect();
    expect(metricLines(world, "SimUntrusted")).toHaveLength(1);
    expect(await untrustedAudit()).toEqual([expect.objectContaining({ decision: "DENY", action: "SIM_UNTRUSTED", reason: "DMARC", clockId: CLOCK, atSim: "2026-10-15T22:10:00.000Z" })]);
    expect(await probeOf(world, MAIL_ID)).toBeUndefined();
    expect((await pendingOf(world)).mails.map((mail) => mail.mailId)).toEqual([MAIL_ID]);
  });

  it("[FL-088] a From that is neither a thread address nor avisos@ is discarded; ours by DMARC with X-Legajo-Mail-Id (email.inject, SC-15/10), its pending closes with PROBE#MAIL# SIM_UNTRUSTED", async () => {
    await world.email.stores.connector.world.putMailPending({ clockId: CLOCK, mailId: "qa0123456789abcdef", from: INJECTOR, to: QINGDAO, profile: "QA", awaiting: "SIMMAIL", sentAtReal: REAL_NOW });
    const event = deliverSim(world, { sesMessageId: "ses-in-inject", recipient: QINGDAO, from: INJECTOR, rfcMessageId: RFC_ID, mailIdHeader: `qa0123456789abcdef; clock=${CLOCK}` });
    expect(await receiveSimMail(event, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "FROM" });
    await expectNoEffect();
    expect(await probeOf(world, "qa0123456789abcdef")).toMatchObject({ outcome: "SIM_UNTRUSTED", reason: "SIM_UNTRUSTED", clockId: CLOCK });
    expect((await pendingOf(world)).mails.map((mail) => mail.mailId)).toEqual([MAIL_ID]);
    expect(metricLines(world, "SimUntrusted")).toHaveLength(1);
  });

  it("[FL-088] a Message-ID that is no outbound of ours, or one of another domain, is discarded even from our own thread address", async () => {
    const unknown = deliverSim(world, { sesMessageId: "ses-in-unknown", recipient: QINGDAO, from: fromThread(), rfcMessageId: "<0100019a2b3c4d5e-never-sent@email.amazonses.com>" });
    expect(await receiveSimMail(unknown, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "MESSAGE_ID" });
    const foreign = deliverSim(world, { sesMessageId: "ses-in-foreign", recipient: QINGDAO, from: fromThread(), rfcMessageId: `<${OUT_ID}@mail.attacker.example.net>` });
    expect(await receiveSimMail(foreign, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "MESSAGE_ID" });
    await expectNoEffect();
    expect(metricLines(world, "SimUntrusted")).toHaveLength(2);
  });

  it("[FL-088] the outbound must have gone to exactly the mailbox that received it, from the author that signs it", async () => {
    const otherMailbox = deliverSim(world, { sesMessageId: "ses-in-other-box", recipient: SANTOSVERDE, from: fromThread(), rfcMessageId: RFC_ID });
    expect(await receiveSimMail(otherMailbox, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "MESSAGE_ID" });
    const otherAuthor = deliverSim(world, { sesMessageId: "ses-in-other-author", recipient: QINGDAO, from: `"Legajo listo" <avisos@legajo.demo.craftech.io>`, rfcMessageId: RFC_ID });
    expect(await receiveSimMail(otherAuthor, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "MESSAGE_ID" });
    await expectNoEffect(SANTOSVERDE);
    expect(await mailboxOf(world, QINGDAO)).toEqual([]);
  });

  it("[FL-088] an ambiguous author (two From headers) or more than one recipient is never ours", async () => {
    const twoFrom = deliverSim(world, { sesMessageId: "ses-in-two-from", recipient: QINGDAO, from: fromThread(), fromHeaders: [fromThread(), "attacker@mail.attacker.example.net"], rfcMessageId: RFC_ID });
    expect(await receiveSimMail(twoFrom, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "FROM" });
    const twoRecipients = deliverSim(world, { sesMessageId: "ses-in-two-rcpt", recipient: QINGDAO, recipients: [QINGDAO, SANTOSVERDE], from: fromThread(), rfcMessageId: RFC_ID });
    expect(await receiveSimMail(twoRecipients, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "RECIPIENT" });
    await expectNoEffect();
  });

  it("[FL-088] the raw MIME has to name the author and the Message-ID SES saw", async () => {
    const event = deliverSim(world, { sesMessageId: "ses-in-mime", recipient: QINGDAO, from: fromThread(), rfcMessageId: RFC_ID, mimeFrom: "attacker@mail.attacker.example.net", mailIdHeader: `${MAIL_ID}; clock=${CLOCK}` });
    expect(await receiveSimMail(event, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "MIME_MISMATCH" });
    await expectNoEffect();
    expect(await probeOf(world, MAIL_ID)).toMatchObject({ outcome: "SIM_UNTRUSTED" });
  });

  it("[FL-088] a verified mail whose mailbox and outbound disagree (a firm's notice to a supplier's mailbox) is discarded", async () => {
    await recordOutbound(world, { messageId: "msg-4471out9", providerMessageId: "0100019a2b3c4d5e-out-firm-9", to: QINGDAO, from: "avisos@legajo.demo.craftech.io", counterpart: "FIRM" });
    const event = deliverSim(world, { sesMessageId: "ses-in-kind", recipient: QINGDAO, from: `"Legajo listo" <avisos@legajo.demo.craftech.io>`, rfcMessageId: "<0100019a2b3c4d5e-out-firm-9@email.amazonses.com>" });
    expect(await receiveSimMail(event, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "MAILBOX_KIND" });
    await expectNoEffect();
  });

  it("[FL-088] a Cognito account email to a qa-signup mailbox is kept in the bucket and dropped: no reply, no metric, no audit row, no mailbox row", async () => {
    const event = deliverSim(world, { sesMessageId: "ses-in-signup", recipient: SIGNUP_MAILBOX, from: `"Legajo listo" <no-reply@legajo.demo.craftech.io>`, rfcMessageId: "<0100019a2b3c4d5e-cognito-1@email.amazonses.com>" });
    expect(await receiveSimMail(event, world.deps)).toEqual({ outcome: "IGNORED", reason: "ACCOUNT_MAIL" });
    expect(metricLines(world, "SimUntrusted")).toEqual([]);
    expect(await untrustedAudit()).toEqual([]);
    expect(await mailboxOf(world, SIGNUP_MAILBOX)).toEqual([]);
    expect(world.raw.has("ses-in-signup")).toBe(true);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("[FL-088] a mail to an unregistered mailbox is counted but audits nothing (no firm owns it)", async () => {
    const event = deliverSim(world, { sesMessageId: "ses-in-nobody", recipient: "supplier-nobody@sim.legajo.demo.craftech.io", from: fromThread(), rfcMessageId: RFC_ID, dmarc: "GRAY" });
    expect(await receiveSimMail(event, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "DMARC" });
    expect(metricLines(world, "SimUntrusted")).toHaveLength(1);
    expect(await untrustedAudit()).toEqual([]);
  });

  it("[FL-088] the firm's own mailbox is guarded the same way: a forged escalation is not stored", async () => {
    const event = deliverSim(world, { sesMessageId: "ses-in-forged", recipient: FIRM_MAILBOX, from: `"Legajo listo" <avisos@legajo.demo.craftech.io>`, rfcMessageId: "<0100019a2b3c4d5e-forged@email.amazonses.com>" });
    expect(await receiveSimMail(event, world.deps)).toEqual({ outcome: "SIM_UNTRUSTED", reason: "MESSAGE_ID" });
    expect(await mailboxOf(world, FIRM_MAILBOX)).toEqual([]);
    expect(await untrustedAudit()).toHaveLength(1);
  });

  it("[FL-088] a redelivery of the same SES message does nothing the second time", async () => {
    const event = deliverSim(world, { sesMessageId: "ses-in-twice", recipient: QINGDAO, from: fromThread(), rfcMessageId: RFC_ID, operationNumber: "4471", request: "kind=DOCS_REQUEST; docs=PACKING_LIST,CERTIFICATE_OF_ORIGIN", mailIdHeader: `${MAIL_ID}; clock=${CLOCK}` });
    expect(await receiveSimMail(event, world.deps)).toMatchObject({ outcome: "SIM_REPLY_SCHEDULED" });
    expect(await receiveSimMail(event, world.deps)).toEqual({ outcome: "DUPLICATE" });
    expect(await simTimers(world)).toHaveLength(1);
    expect(await mailboxOf(world, QINGDAO)).toHaveLength(1);
  });
});

describe("[FL-088] loop guards and caps of the simulator, in simulated and real time", () => {
  const request = { operationNumber: "4471", request: "kind=DOCS_REQUEST; docs=PACKING_LIST,CERTIFICATE_OF_ORIGIN", mailIdHeader: `${MAIL_ID}; clock=${CLOCK}` };
  const deliver = (sesMessageId: string, extra: Partial<Parameters<typeof deliverSim>[1]> = {}) => deliverSim(world, { sesMessageId, recipient: QINGDAO, from: fromThread(), rfcMessageId: RFC_ID, ...request, ...extra });

  it("[FL-088] never answers a mail with Auto-Submitted other than no, but still shows it in the mailbox and closes its pending", async () => {
    expect(await receiveSimMail(deliver("ses-in-auto", { headers: ["Auto-Submitted: auto-generated"] }), world.deps)).toMatchObject({ outcome: "NO_REPLY", reason: "AUTO_SUBMITTED" });
    expect(await simTimers(world)).toEqual([]);
    expect(await mailboxOf(world, QINGDAO)).toHaveLength(1);
    expect(await probeOf(world, MAIL_ID)).toMatchObject({ outcome: "NO_REPLY", reason: "AUTO_SUBMITTED", operationId: "op-4471" });
    expect((await pendingOf(world)).mails).toEqual([]);
  });

  it("[FL-088] never answers anything but a thread address of a live world: avisos@ or a tombstoned epoch get no reply", async () => {
    await recordOutbound(world, { messageId: "msg-4471out7", providerMessageId: "0100019a2b3c4d5e-out-notice-7", to: QINGDAO, from: "avisos@legajo.demo.craftech.io" });
    const notice = deliverSim(world, { sesMessageId: "ses-in-notice", recipient: QINGDAO, from: `"Legajo listo" <avisos@legajo.demo.craftech.io>`, rfcMessageId: "<0100019a2b3c4d5e-out-notice-7@email.amazonses.com>" });
    expect(await receiveSimMail(notice, world.deps)).toMatchObject({ outcome: "NO_REPLY", reason: "NOT_A_THREAD" });
    await world.email.stores.connector.world.putTombstone({ clockId: CLOCK, worldEpoch: 1, atReal: REAL_NOW });
    expect(await receiveSimMail(deliver("ses-in-tomb"), world.deps)).toMatchObject({ outcome: "NO_REPLY", reason: "WORLD_GONE" });
    expect(await simTimers(world)).toEqual([]);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("[FL-088] at most 6 replies per operation and simulated day, and per real day", async () => {
    const operations = world.email.stores.connector.operations;
    const capped = async (state: Record<string, unknown>) => {
      const current = await operations.getOperation("op-4471");
      await operations.updateOperation("op-4471", { simState: { ...current.simState, ...state } }, current.version);
    };
    await capped({ repliesOnSimDay: { day: "2026-10-15", count: 6 } });
    expect(await receiveSimMail(deliver("ses-in-cap-sim"), world.deps)).toMatchObject({ outcome: "NO_REPLY", reason: "REPLY_CAP" });
    await capped({ repliesOnSimDay: { day: "2026-10-15", count: 5 }, repliesOnRealDay: { day: "2026-09-26", count: 6 } });
    expect(await receiveSimMail(deliver("ses-in-cap-real"), world.deps)).toMatchObject({ outcome: "NO_REPLY", reason: "REPLY_CAP" });
    await capped({ repliesOnRealDay: { day: "2026-09-25", count: 6 } });
    expect(await receiveSimMail(deliver("ses-in-cap-ok"), world.deps)).toMatchObject({ outcome: "SIM_REPLY_SCHEDULED" });
    expect(await simTimers(world)).toHaveLength(1);
  });
});

