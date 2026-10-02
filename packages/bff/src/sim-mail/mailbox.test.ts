import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { receiveSimMail } from "./receive";
import { CLOCK, FIRM, FIRM_MAILBOX, QINGDAO, type SimWorld, deliverSim, mailboxOf, pendingOf, probeOf, recordOutbound, simWorld } from "./testing";

const ses = mockClient(SESv2Client);
const NOTICES = `"Legajo listo" <avisos@legajo.demo.craftech.io>`;
const ESCALATION_ID = "0100019a2b3c4d5e-out-esc-0001";
const ESCALATION_RFC = `<${ESCALATION_ID}@email.amazonses.com>`;
const ESCALATION_MAIL = "01JQESCALATIONMAIL00000001";

let world: SimWorld;

beforeEach(async () => {
  ses.reset();
  ses.on(SendEmailCommand).resolves({ MessageId: "0100019a2b3c4d5e-sim-reply-0001" });
  world = await simWorld();
  await recordOutbound(world, {
    messageId: "msg-4471esc1",
    providerMessageId: ESCALATION_ID,
    to: FIRM_MAILBOX,
    from: "avisos@legajo.demo.craftech.io",
    counterpart: "FIRM",
    kind: "ESCALATION_NOTICE",
    docTypes: [],
    subject: "[Op 4471] Escalation: packing list observation (supuesto)",
    mailId: ESCALATION_MAIL,
  });
});

const escalation = (extra: Partial<Parameters<typeof deliverSim>[1]> = {}) =>
  deliverSim(world, { sesMessageId: "ses-in-esc-1", recipient: FIRM_MAILBOX, from: NOTICES, rfcMessageId: ESCALATION_RFC, mailIdHeader: `${ESCALATION_MAIL}; clock=${CLOCK}`, subject: "[Op 4471] Escalation: packing list observation (supuesto)", ...extra });

describe("[FL-084] the demo mailbox keeps only verified mail, with the firm of the outbound it answers", () => {
  it("[FL-084] an escalation to the firm's mailbox becomes a MailboxMessage with the operation's firm, world and simulated time; then its pending closes with MAILBOX", async () => {
    const result = await receiveSimMail(escalation({ text: "The packing list of operation 4471 still has an observation. Reply from the console." }), world.deps);
    expect(result).toEqual({ outcome: "MAILBOX", operationId: "op-4471" });
    const [mail] = await mailboxOf(world, FIRM_MAILBOX);
    expect(mail).toMatchObject({
      mailboxAddress: FIRM_MAILBOX,
      mailboxMessageId: "ses-in-esc-1",
      firmId: FIRM,
      operationId: "op-4471",
      clockId: CLOCK,
      from: "avisos@legajo.demo.craftech.io",
      to: FIRM_MAILBOX,
      subject: "[Op 4471] Escalation: packing list observation (supuesto)",
      bodyText: "The packing list of operation 4471 still has an observation. Reply from the console.",
      receivedAtSim: "2026-10-15T22:10:00.000Z",
      sesMessageId: "ses-in-esc-1",
    });
    expect(await probeOf(world, ESCALATION_MAIL)).toMatchObject({ outcome: "MAILBOX", operationId: "op-4471" });
    expect((await pendingOf(world)).mails).toEqual([]);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("[FL-084] the firmId comes from the verified outbound's operation, never from the address the mail came to", async () => {
    await recordOutbound(world, { messageId: "msg-5501esc1", providerMessageId: "0100019a2b3c4d5e-out-esc-norte", to: FIRM_MAILBOX, from: "avisos@legajo.demo.craftech.io", counterpart: "FIRM", kind: "ESCALATION_NOTICE", docTypes: [], firmId: "firm-norte" });
    await receiveSimMail(deliverSim(world, { sesMessageId: "ses-in-esc-norte", recipient: FIRM_MAILBOX, from: NOTICES, rfcMessageId: "<0100019a2b3c4d5e-out-esc-norte@email.amazonses.com>" }), world.deps);
    expect((await mailboxOf(world, FIRM_MAILBOX)).map((mail) => mail.firmId)).toEqual(["firm-norte"]);
  });

  it("[FL-084] a mail that is not verified is never stored, in the firm's mailbox or a supplier's", async () => {
    expect(await receiveSimMail(escalation({ dmarc: "FAIL" }), world.deps)).toMatchObject({ outcome: "SIM_UNTRUSTED" });
    expect(await mailboxOf(world, FIRM_MAILBOX)).toEqual([]);
    const forged = deliverSim(world, { sesMessageId: "ses-in-forged-supplier", recipient: QINGDAO, from: NOTICES, rfcMessageId: "<0100019a2b3c4d5e-out-never@email.amazonses.com>" });
    expect(await receiveSimMail(forged, world.deps)).toMatchObject({ outcome: "SIM_UNTRUSTED" });
    expect(await mailboxOf(world, QINGDAO)).toEqual([]);
  });

  it("[FL-084] the body is kept as plain text: an HTML-only mail is converted, its script dropped, sensitive numbers masked", async () => {
    const html = "<html><head><script>alert('x')</script></head><body><p>Observation on <b>4471</b>.</p><p>CUIT 30-71234567-0</p></body></html>";
    await receiveSimMail(escalation({ html }), world.deps);
    const [mail] = await mailboxOf(world, FIRM_MAILBOX);
    expect(mail?.bodyText).toContain("Observation on 4471.");
    expect(mail?.bodyText).toContain("[CUIT]");
    expect(mail?.bodyText).not.toMatch(/<|script|alert|30-71234567-0/);
  });

  it("[FL-084] a supplier's mailbox shows our request too, with the operation's firm, next to what the simulator does with it", async () => {
    await recordOutbound(world, { messageId: "msg-4471out1", providerMessageId: "0100019a2b3c4d5e-out-req-0001", to: QINGDAO });
    const event = deliverSim(world, { sesMessageId: "ses-in-req-1", recipient: QINGDAO, from: `"Estudio Delta via Legajo listo" <${world.email.op4471.threadAddress}>`, rfcMessageId: "<0100019a2b3c4d5e-out-req-0001@email.amazonses.com>", operationNumber: "4471", request: "kind=DOCS_REQUEST; docs=PACKING_LIST" });
    expect(await receiveSimMail(event, world.deps)).toMatchObject({ outcome: "SIM_REPLY_SCHEDULED", operationId: "op-4471" });
    expect(await mailboxOf(world, QINGDAO)).toEqual([expect.objectContaining({ firmId: FIRM, operationId: "op-4471", from: world.email.op4471.threadAddress, to: QINGDAO })]);
  });

  it("[FL-084] a redelivered mail is stored once", async () => {
    await receiveSimMail(escalation(), world.deps);
    expect(await receiveSimMail(escalation(), world.deps)).toEqual({ outcome: "DUPLICATE" });
    expect(await mailboxOf(world, FIRM_MAILBOX)).toHaveLength(1);
  });
});
