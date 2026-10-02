// FL-115: the lead notice is the one profile without a clock (ADR-0015 §6): the single SES client sends
// it from avisos@ to an exact @craftech.io recipient on the app's configuration set, and touches neither
// `Runtime` (no PENDING#/MAIL#, no probe) nor the audit log nor `Conversations`, adds no
// `X-Legajo-Mail-Id`; every other profile without a `clockId` is refused as INVALID.
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelError, NOTICES_ADDRESS } from "@legajo/shared";
import { createLogger } from "../../lib/log";
import { type EmailClient, createEmailClient } from "./outbound";
import { emailWorld, fenceDeps, type EmailWorld } from "./testing";

const ses = mockClient(SESv2Client);
let world: EmailWorld;
let client: EmailClient;
let touched: string[];

const spy = (port: string) =>
  vi.fn(() => {
    touched.push(port);
    return Promise.reject(new Error(`${port} must not be used by LEAD_NOTICE`));
  });

beforeEach(async () => {
  ses.reset();
  ses.on(SendEmailCommand).resolves({ MessageId: "0100019a2b3c4d5e-lead-000001" });
  world = await emailWorld();
  touched = [];
  client = createEmailClient({
    fence: fenceDeps(world),
    world: { putMailPending: spy("Runtime.putMailPending"), getMailPending: spy("Runtime.getMailPending"), closeMailPending: spy("Runtime.closeMailPending") },
    runtime: { putMailProbe: spy("Runtime.putMailProbe") },
    audit: { record: spy("AuditLog.record") },
    configurationSet: (profile) => `aws-cds-hackathon-poc-legajo-${profile === "LEAD_NOTICE" || profile === "SYSTEM" ? "email" : "sim"}-poc`,
    stage: "poc",
    now: () => new Date("2026-10-14T13:30:00.000Z"),
    newMailId: () => {
      touched.push("newMailId");
      return "01JQMAIL000000000000000001";
    },
    log: createLogger({ level: "error" }),
    ses: new SESv2Client({ region: "us-east-1" }),
  });
});

const notice = { profile: "LEAD_NOTICE" as const, from: { address: NOTICES_ADDRESS, displayName: "Legajo listo" }, to: "ventas@craftech.io", subject: "[Legajo listo] Nuevo registro en la demo", text: "Nuevo registro en la demo de Legajo listo.", lang: "es" as const, kind: "LEAD_NOTICE" };

describe("[FL-115] the lead notice has no clock", () => {
  it("sends without a pending mail, a probe, an audit row or X-Legajo-Mail-Id", async () => {
    const result = await client.send(notice);
    expect(result).toMatchObject({ status: "SENT", providerMessageId: "0100019a2b3c4d5e-lead-000001", to: "ventas@craftech.io" });
    expect(result.status === "SENT" && result.mailId).toBeUndefined();
    expect(touched).toEqual([]);
    const input = ses.commandCalls(SendEmailCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ FromEmailAddress: "\"Legajo listo\" <avisos@legajo.demo.craftech.io>", Destination: { ToAddresses: ["ventas@craftech.io"] }, ConfigurationSetName: "aws-cds-hackathon-poc-legajo-email-poc" });
    expect(JSON.stringify(input)).not.toContain("X-Legajo-Mail-Id");
    expect(await world.stores.connector.world.listPending("GLOBAL#firm-delta")).toEqual({ mails: [], scans: [] });
  });

  it("refuses a recipient outside @craftech.io before SES, and still writes nothing", async () => {
    expect(await client.send({ ...notice, to: "ventas@mail.craftech.io" })).toEqual({ status: "REFUSED", code: "RECIPIENT_NOT_ALLOWED", reason: "LEAD_NOTICE_RECIPIENT" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(touched).toEqual([]);
  });

  it("a lead notice carrying a clock, and any other profile without one, are INVALID", async () => {
    await expect(client.send({ ...notice, clockId: "GLOBAL#firm-delta" } as never)).rejects.toMatchObject({ code: "INVALID" });
    const system = { profile: "SYSTEM" as const, from: { address: NOTICES_ADDRESS }, to: "estudio-delta@sim.legajo.demo.craftech.io", subject: "Escalamiento", text: "Texto", lang: "es" as const, firmId: "firm-delta", kind: "ESCALATION" };
    await expect(client.send(system as never)).rejects.toBeInstanceOf(ChannelError);
    await expect(client.send(system as never)).rejects.toMatchObject({ code: "INVALID" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});
