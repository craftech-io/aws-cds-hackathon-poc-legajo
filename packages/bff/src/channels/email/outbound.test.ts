import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { ChannelError, computeThreadTag, threadAddress } from "@legajo/shared";
import { contactFixture, hashOf, operationFixture, supplierFixture } from "../../connector/testing";
import type { Operation } from "../../domain/operations";
import { createLogger } from "../../lib/log";
import { type EmailClient, type EmailSendRequest, createEmailClient } from "./outbound";
import { CLOCK, type EmailWorld, QINGDAO, REAL_NOW, SANTOSVERDE, TEST_THREAD_KEY, emailWorld, fenceDeps } from "./testing";

const QA_CLOCK = "qa-812-1-sc15";
const QA_A = "qa-812-1-sc15-a-qingdao@sim.legajo.demo.craftech.io";
const QA_B = "qa-812-1-sc15-b-santosverde@sim.legajo.demo.craftech.io";
const INJECTOR = "qainject-812-1-sc15@sim.legajo.demo.craftech.io";
const DEMO_INBOX = "team.lead@legajo-team.craftech.io";
const ses = mockClient(SESv2Client);

let world: EmailWorld;
let client: EmailClient;
let lines: string[];
let qaA: Operation;
let guest: Operation;

async function cloneWorld(clockId: string, firmId: string, key: string, number: string, clockTag: string, mailbox: string): Promise<Operation> {
  const { parties, operations, world: runtime } = world.stores.connector;
  if ((await runtime.findClock(clockId)) === undefined) await runtime.createClock({ clockId, firmId, mode: "PAUSED", pausedSimNow: "2026-10-15T12:58:00.000Z", startAtSim: "2026-10-15T12:58:00.000Z", worldEpoch: 1 });
  const supplierId = `sup-${key}`;
  await parties.createSupplier(supplierFixture({ supplierId, firmId, clockId }));
  await parties.createContact(contactFixture({ contactId: `ctc-${key}-1`, supplierId, firmId, clockId, email: mailbox, emailHash: hashOf(mailbox) }));
  const tag = await computeThreadTag(TEST_THREAD_KEY, { operationNumber: number, clockId, worldEpoch: 1 });
  const address = threadAddress(number, tag);
  return operations.createOperation({ ...operationFixture({ operationId: `op-${number}-${clockTag}`, operationNumber: number, firmId, clockId, supplierId, threadTag: tag, threadAddress: address }), threadClaimHash: hashOf(address) });
}

beforeEach(async () => {
  ses.reset();
  ses.on(SendEmailCommand).resolves({ MessageId: "0100019a2b3c4d5e-out-000001" });
  world = await emailWorld();
  qaA = await cloneWorld(QA_CLOCK, "firm-qa", "qa-812-1-sc15-a", "7042", "q1", QA_A);
  await cloneWorld(QA_CLOCK, "firm-qa", "qa-812-1-sc15-b", "7043", "q1", QA_B);
  guest = await cloneWorld("GUEST#firm-guest-01", "firm-guest-01", "g01-qingdao", "4471", "g01", "g01-qingdao@sim.legajo.demo.craftech.io");
  lines = [];
  let sequence = 0;
  client = createEmailClient({
    fence: fenceDeps(world, [DEMO_INBOX]),
    world: world.stores.connector.world,
    runtime: world.stores.connector.runtime,
    audit: world.stores.connector.audit,
    configurationSet: (profile) => `aws-cds-hackathon-poc-legajo-${profile === "SYSTEM" ? "email" : "sim"}-poc`,
    stage: "poc",
    now: () => new Date(REAL_NOW),
    newMailId: () => `01JQMAIL${String(++sequence).padStart(18, "0")}`,
    log: createLogger({ level: "debug", sink: (line) => lines.push(line) }),
    ses: new SESv2Client({ region: "us-east-1" }),
  });
});

function systemRequest(overrides: Partial<Extract<EmailSendRequest, { profile: "SYSTEM" }>> = {}): EmailSendRequest {
  return {
    profile: "SYSTEM",
    from: { address: world.op4471.threadAddress, displayName: "Estudio Delta via Legajo listo" },
    replyTo: world.op4471.threadAddress,
    to: QINGDAO,
    subject: "[Op 4471] Missing documents: packing list, certificate of origin (Invoice QBT-2026-0917)",
    text: "Hello,\n\nWe still need the packing list and the certificate of origin of invoice QBT-2026-0917 <FOB>.\nDeadline: 18/10 17:00 (Qingdao time).",
    lang: "en",
    request: { kind: "DOCS_REQUEST", docTypes: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"] },
    operationNumber: "4471",
    clockId: CLOCK,
    firmId: "firm-delta",
    operationId: "op-4471",
    messageId: "msg-4471out2",
    kind: "DOCS_REQUEST",
    actor: "AGENT",
    ...overrides,
  };
}

const header = (name: string) => ses.commandCalls(SendEmailCommand)[0]?.args[0].input.Content?.Simple?.Headers?.find((entry) => entry.Name === name)?.Value;
const pendings = () => world.stores.connector.world.listPending(CLOCK);
const denials = () => world.stores.connector.audit.listByDecision("firm-delta", "DENY");

describe("[FL-012] the first request to the supplier goes out through the single SES client", () => {
  it("[FL-012] sends with profile SYSTEM from the operation's address, validated headers, the email configuration set and tags, after writing the pending mail", async () => {
    let pendingAtSend: unknown;
    ses.on(SendEmailCommand).callsFake(async () => {
      pendingAtSend = (await pendings()).mails[0];
      return { MessageId: "0100019a2b3c4d5e-out-000001" };
    });
    const result = await client.send(systemRequest({ inReplyTo: "<reply-4471-1@sim.legajo.demo.craftech.io>", references: ["<0100019a-first@email.amazonses.com>", "<reply-4471-1@sim.legajo.demo.craftech.io>"] }));

    expect(result).toEqual({ status: "SENT", providerMessageId: "0100019a2b3c4d5e-out-000001", rfcMessageId: "<0100019a2b3c4d5e-out-000001@email.amazonses.com>", mailId: "01JQMAIL000000000000000001", awaiting: "SIMMAIL", from: world.op4471.threadAddress, to: QINGDAO });
    const input = ses.commandCalls(SendEmailCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      FromEmailAddress: `"Estudio Delta via Legajo listo" <${world.op4471.threadAddress}>`,
      ReplyToAddresses: [world.op4471.threadAddress],
      Destination: { ToAddresses: [QINGDAO] },
      ConfigurationSetName: "aws-cds-hackathon-poc-legajo-email-poc",
      EmailTags: [
        { Name: "stage", Value: "poc" },
        { Name: "kind", Value: "DOCS_REQUEST" },
        { Name: "mailId", Value: "01JQMAIL000000000000000001" },
        { Name: "operationId", Value: "op-4471" },
        { Name: "messageId", Value: "msg-4471out2" },
      ],
    });
    expect(input?.Content?.Simple?.Subject?.Data).toBe("[Op 4471] Missing documents: packing list, certificate of origin (Invoice QBT-2026-0917)");
    expect(input?.Content?.Simple?.Body?.Text?.Data).toContain("invoice QBT-2026-0917 <FOB>");
    expect(input?.Content?.Simple?.Body?.Html?.Data).toContain("invoice QBT-2026-0917 &lt;FOB&gt;.<br>Deadline");
    expect(input?.Content?.Simple?.Attachments).toBeUndefined();
    expect(header("X-Legajo-Operation")).toBe("4471");
    expect(header("X-Legajo-Request")).toBe("kind=DOCS_REQUEST; docs=PACKING_LIST,CERTIFICATE_OF_ORIGIN");
    expect(header("X-Legajo-Mail-Id")).toBe("01JQMAIL000000000000000001; clock=GLOBAL#firm-delta");
    expect(header("In-Reply-To")).toBe("<reply-4471-1@sim.legajo.demo.craftech.io>");
    expect(header("References")).toBe("<0100019a-first@email.amazonses.com> <reply-4471-1@sim.legajo.demo.craftech.io>");
    expect(pendingAtSend).toMatchObject({ mailId: "01JQMAIL000000000000000001", from: world.op4471.threadAddress, to: QINGDAO, profile: "SYSTEM", awaiting: "SIMMAIL", operationId: "op-4471" });
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(expect.objectContaining({ metric: "OutboundSent", channel: "EMAIL", kind: "DOCS_REQUEST" }));
  });

  it("[FL-012] refuses a header value with CR/LF before SES and before any pending mail", async () => {
    const result = await client.send(systemRequest({ subject: "[Op 4471] Missing\r\nBcc: someone@mail.attacker.example.net" }));
    expect(result).toEqual({ status: "REFUSED", code: "INVALID", reason: "HEADER_INVALID" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect((await pendings()).mails).toEqual([]);
    expect((await denials()).map((row) => [row.action, row.ruleIds])).toEqual([["EMAIL_INVALID", []]]);
  });

  it("[FL-012] encodes a non-ASCII firm name per RFC 2047 and never lets Reply-To point elsewhere", async () => {
    await client.send(systemRequest({ from: { address: world.op4471.threadAddress, displayName: "Estudio Delta · despachos via Legajo listo" } }));
    expect(ses.commandCalls(SendEmailCommand)[0]?.args[0].input.FromEmailAddress).toMatch(/^=\?UTF-8\?B\?.+\?= <op-4471-/);
    expect(await client.send(systemRequest({ replyTo: SANTOSVERDE }))).toMatchObject({ status: "REFUSED", code: "INVALID", reason: "REPLY_TO_NOT_FROM" });
    await expect(client.send({ ...systemRequest(), attachments: [] } as unknown as EmailSendRequest)).rejects.toThrow(ChannelError);
  });

  it("closes the pending mail with SEND_FAILED when SES fails, and maps the error", async () => {
    ses.on(SendEmailCommand).rejects(Object.assign(new Error("slow down"), { name: "TooManyRequestsException" }));
    await expect(client.send(systemRequest())).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect((await pendings()).mails).toEqual([]);
    expect(await world.stores.connector.runtime.getMailProbe("01JQMAIL000000000000000001")).toMatchObject({ outcome: "DISCARDED", reason: "SEND_FAILED" });
    ses.on(SendEmailCommand).rejects(Object.assign(new Error("rejected"), { name: "MessageRejected" }));
    await expect(client.send(systemRequest())).rejects.toMatchObject({ code: "SEND_FAILED", retryable: false });
  });
});

describe("[FL-059] the recipient fence lives inside the single client", () => {
  it.each([
    ["x@proveedor.test"],
    ["x@example.com"],
    ["x@example.net"],
    ["x@example.org"],
    ["x@algo.example"],
    ["x@algo.invalid"],
    ["x@algo.localhost"],
    ["x@sim.legajo.demo.craftech.io.attacker.example"],
    ["x@supplier-mail.sim"],
    ["X@SIM.legajo.demo.craftech.io"],
    ["x@sim.legajo.demo.craftech.io."],
    ['"x"@sim.legajo.demo.craftech.io'],
    ["x@xn--prvedor-9za.sim.legajo.demo.craftech.io"],
    ["x@y@sim.legajo.demo.craftech.io"],
    ["x@sim.legajo.demo.craftech.io\r\nBcc: a@b.co"],
  ])("[FL-059] %s is refused before SendEmail, with no pending mail and an audited DENY", async (to) => {
    const result = await client.send(systemRequest({ to }));
    expect(result.status).toBe("REFUSED");
    expect(result.status === "REFUSED" ? result.code : undefined).toMatch(/^(RECIPIENT_NOT_ALLOWED|INVALID)$/);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect((await pendings()).mails).toEqual([]);
    expect((await denials())[0]).toMatchObject({ decision: "DENY", ruleIds: ["CP-RECIPIENT-FENCE"], evaluated: [{ ruleId: "CP-RECIPIENT-FENCE", result: "DENY" }] });
  });

  it("[FL-059] SYSTEM writes to sim mailboxes, SES's simulator and registered demo recipients, never to a thread address", async () => {
    expect(await client.checkRecipient({ profile: "SYSTEM", from: world.op4471.threadAddress, operationId: "op-4471", to: "bounce+812-1-sc05-a@simulator.amazonses.com" })).toMatchObject({ allowed: true, awaiting: "SES_EVENT" });
    expect(await client.checkRecipient({ profile: "SYSTEM", from: "avisos@legajo.demo.craftech.io", to: DEMO_INBOX })).toMatchObject({ allowed: true, awaiting: "SES_EVENT" });
    expect(await client.checkRecipient({ profile: "SYSTEM", from: "avisos@legajo.demo.craftech.io", to: "estudio-delta@sim.legajo.demo.craftech.io" })).toMatchObject({ allowed: true, awaiting: "SIMMAIL" });
    expect(await client.checkRecipient({ profile: "SYSTEM", from: world.op4471.threadAddress, operationId: "op-4471", to: world.op4483.threadAddress })).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "SYSTEM_TO_THREAD" });
    expect(await client.checkRecipient({ profile: "SYSTEM", from: world.op4471.threadAddress, operationId: "op-4471", to: "someone@legajo-team.craftech.io" })).toMatchObject({ allowed: false, reason: "SYSTEM_RECIPIENT" });
    expect(await client.checkRecipient({ profile: "SYSTEM", from: QINGDAO, to: SANTOSVERDE })).toMatchObject({ allowed: false, code: "INVALID", reason: "SYSTEM_FROM" });
    expect(await client.checkRecipient({ profile: "SYSTEM", from: world.op4471.threadAddress, operationId: "op-4483", to: QINGDAO })).toMatchObject({ allowed: false, code: "INVALID", reason: "SYSTEM_FROM" });
    expect(await client.checkRecipient({ profile: "SYSTEM", from: world.op4471.threadAddress, to: QINGDAO })).toMatchObject({ allowed: false, code: "INVALID", reason: "SYSTEM_FROM" });
    expect(await client.checkRecipient({ profile: "SYSTEM", from: "op-4471-zzzzzz@legajo.demo.craftech.io", operationId: "op-4471", to: QINGDAO })).toMatchObject({ allowed: false, reason: "SYSTEM_FROM" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect((await pendings()).mails).toEqual([]);
  });

  it("[FL-059] SIMULATOR answers only the verified thread, only from an ACTIVE contact of that operation's supplier", async () => {
    const answered = { from: world.op4471.threadAddress, to: QINGDAO };
    const reply = (from: string, to: string, purpose: { kind: "REPLY"; answered: { from: string; to: string } } | { kind: "SEND_NOW"; operationId: string } = { kind: "REPLY", answered }) => client.checkRecipient({ profile: "SIMULATOR", from, to, purpose });
    expect(await reply(QINGDAO, world.op4471.threadAddress)).toMatchObject({ allowed: true, awaiting: "INBOUND" });
    expect(await reply(QINGDAO, "estudio-delta@sim.legajo.demo.craftech.io")).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "SIMULATOR_RECIPIENT" });
    expect(await reply(SANTOSVERDE, world.op4483.threadAddress)).toMatchObject({ allowed: false, reason: "SIMULATOR_NOT_ANSWERED_THREAD" });
    expect(await reply(SANTOSVERDE, world.op4471.threadAddress, { kind: "REPLY", answered: { from: world.op4471.threadAddress, to: SANTOSVERDE } })).toMatchObject({ allowed: false, code: "INVALID", reason: "SIMULATOR_FROM" });
    expect(await reply("nobody@sim.legajo.demo.craftech.io", world.op4471.threadAddress, { kind: "REPLY", answered: { from: world.op4471.threadAddress, to: "nobody@sim.legajo.demo.craftech.io" } })).toMatchObject({ allowed: false, code: "INVALID" });
    expect(await reply(QINGDAO, world.op4471.threadAddress, { kind: "SEND_NOW", operationId: "op-4471" })).toMatchObject({ allowed: true });
    expect(await reply(QINGDAO, world.op4471.threadAddress, { kind: "SEND_NOW", operationId: "op-4483" })).toMatchObject({ allowed: false, reason: "SIMULATOR_NOT_ANSWERED_THREAD" });
    expect(await reply(QA_A, qaA.threadAddress, { kind: "REPLY", answered: { from: qaA.threadAddress, to: QA_A } })).toMatchObject({ allowed: true, awaiting: "INBOUND" });
    await world.stores.connector.world.putTombstone({ clockId: CLOCK, worldEpoch: 1, atReal: REAL_NOW });
    expect(await reply(QINGDAO, world.op4471.threadAddress)).toMatchObject({ allowed: false, reason: "SIMULATOR_RECIPIENT" });
  });

  it("[FL-059] QA writes from its injector or a non-ACTIVE party of a qa-* world, only to its own mailboxes and threads or to none", async () => {
    const qa = (from: string, to: string) => client.checkRecipient({ profile: "QA", from, to });
    expect(await qa(INJECTOR, qaA.threadAddress)).toMatchObject({ allowed: true, awaiting: "INBOUND" });
    expect(await qa(QA_B, qaA.threadAddress)).toMatchObject({ allowed: true });
    expect(await qa(QA_A, qaA.threadAddress)).toMatchObject({ allowed: false, code: "INVALID", reason: "QA_FROM_ACTIVE_CONTACT" });
    expect(await qa(INJECTOR, world.op4471.threadAddress)).toMatchObject({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", reason: "QA_RECIPIENT" });
    expect(await qa(INJECTOR, guest.threadAddress)).toMatchObject({ allowed: false, reason: "QA_RECIPIENT" });
    expect(await qa(INJECTOR, "op-9999-abcdef@legajo.demo.craftech.io")).toMatchObject({ allowed: true, awaiting: "INBOUND" });
    expect(await qa(INJECTOR, "op-7042-zzzzzz@legajo.demo.craftech.io")).toMatchObject({ allowed: true });
    expect(await qa(INJECTOR, QA_B)).toMatchObject({ allowed: true, awaiting: "SIMMAIL" });
    expect(await qa(INJECTOR, "estudio-qa-812-1-sc15@sim.legajo.demo.craftech.io")).toMatchObject({ allowed: false, reason: "QA_RECIPIENT" });
    expect(await qa(INJECTOR, "avisos@legajo.demo.craftech.io")).toMatchObject({ allowed: false, reason: "QA_RECIPIENT" });
    expect(await qa("someone@sim.legajo.demo.craftech.io", qaA.threadAddress)).toMatchObject({ allowed: false, code: "INVALID", reason: "QA_FROM" });
    expect(await qa(QINGDAO, qaA.threadAddress)).toMatchObject({ allowed: false, code: "INVALID", reason: "QA_FROM" });
  });

  it("[FL-059] a SIMULATOR or QA send carries its PDFs and Auto-Submitted on the simulator configuration set", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
    const result = await client.send({
      profile: "QA",
      from: { address: INJECTOR },
      to: qaA.threadAddress,
      subject: "Out of office",
      text: "Away.",
      lang: "en",
      clockId: QA_CLOCK,
      firmId: "firm-qa",
      operationId: qaA.operationId,
      kind: "QA_INJECT",
      mailId: `qa${"0".repeat(40)}`,
      autoReply: true,
      attachments: [{ filename: "packing-list.pdf", bytes: pdf }],
    });
    expect(result).toMatchObject({ status: "SENT", mailId: `qa${"0".repeat(40)}`, awaiting: "INBOUND" });
    const input = ses.commandCalls(SendEmailCommand)[0]?.args[0].input;
    expect(input?.ConfigurationSetName).toBe("aws-cds-hackathon-poc-legajo-sim-poc");
    expect(input?.Content?.Simple?.Attachments?.[0]).toMatchObject({ FileName: "packing-list.pdf", ContentType: "application/pdf", ContentDisposition: "ATTACHMENT" });
    expect(header("Auto-Submitted")).toBe("auto-replied");
    expect(await client.send({ profile: "QA", from: { address: INJECTOR }, to: qaA.threadAddress, subject: "x", text: "x", lang: "en", clockId: QA_CLOCK, firmId: "firm-qa", kind: "QA_INJECT", attachments: [{ filename: "a.pdf", bytes: new Uint8Array([1, 2, 3]) }] })).toMatchObject({
      status: "REFUSED",
      reason: "ATTACHMENT_NOT_PDF",
    });
  });
});
