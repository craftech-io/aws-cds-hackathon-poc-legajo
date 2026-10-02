// FL-115, ADR-0015 §6: one notice per confirmed sign-up to the mailboxes of the `LeadNoticeTo` secret
// only, each exactly `<local>@craftech.io`; `disabled` or a bad recipient → DISABLED (and the metric for
// the bad one); an SES failure → PENDING for the sweep, FAILED at the fifth attempt. The text carries
// what the ADR lists and nothing more. No destination is written in the code (checked on the sources).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { LEAD_NOTICE_MAX_ATTEMPTS } from "@legajo/shared/guest-limits";
import { memoryStores } from "../../connector/testing";
import { leadEmailHash } from "../../lib/crypto";
import { createLogger } from "../../lib/log";
import { testSignupKeys } from "../../signup/testing";
import type { EmailClient, EmailSendRequest } from "../../channels/email/outbound";
import { type LeadStore, createLeadStore } from "../store";
import { LEAD_NOTICE_SUBJECT, artTime, leadNoticeBody } from "./body";
import { noticeRecipients, notifyLead } from "./notice";

const keys = testSignupKeys();
const NOW = new Date("2026-10-14T13:30:00.000Z");
const EMAIL = "ana.gomez@despachos-del-sur.com.ar";
const HASH = leadEmailHash(keys.leadEmail, EMAIL);

let leads: LeadStore;
let sent: EmailSendRequest[];
let lines: string[];
let fail: boolean;

const email: Pick<EmailClient, "send"> = {
  async send(request) {
    if (fail) throw new Error("SES is throttled");
    sent.push(request);
    return { status: "SENT", providerMessageId: "0100019a2b3c4d5e-lead-1", rfcMessageId: "<0100019a2b3c4d5e-lead-1@email.amazonses.com>", awaiting: "SES_EVENT", from: "avisos@legajo.demo.craftech.io", to: request.to };
  },
};

beforeEach(async () => {
  leads = createLeadStore(memoryStores().client);
  sent = [];
  lines = [];
  fail = false;
  const consent = { at: "2026-10-14T13:00:00.000Z", lang: "es" as const };
  await leads.saveVerifiedLead(
    {
      newLeadId: "01J9ZQ00000000000000000077",
      email: EMAIL,
      emailHash: HASH,
      name: "Ana Gómez (ficticia)",
      company: "Despachos del Sur (ficticia)",
      consents: { terms: { accepted: true, version: "2026-10-02", privacyVersion: "2026-10-02", ...consent }, contact: { accepted: false, version: "2026-10-02", ...consent } },
      language: "en",
      utm: { source: "linkedin" },
      referrer: "https://www.search.example-fict.com",
      signupAt: "2026-10-14T13:00:00.000Z",
      confirmedAt: "2026-10-14T13:05:00.000Z",
      cognitoUsername: "usr-01j9zq00000000000000000001",
    },
    NOW,
  );
});

const run = (secret: string) => notifyLead({ leads, email, recipients: () => secret, now: () => NOW, log: createLogger({ level: "debug", sink: (line) => lines.push(line) }) }, { leadKey: HASH });

describe("[FL-115] the notice of a new lead", () => {
  it("goes to each mailbox of the secret, once, and records SENT", async () => {
    expect(await run("ventas@craftech.io, equipo@craftech.io")).toBe("SENT");
    expect(sent.map((request) => request.to)).toEqual(["ventas@craftech.io", "equipo@craftech.io"]);
    expect(sent[0]).toMatchObject({ profile: "LEAD_NOTICE", from: { address: "avisos@legajo.demo.craftech.io" }, subject: LEAD_NOTICE_SUBJECT, lang: "es" });
    expect(await leads.get(HASH)).toMatchObject({ noticeStatus: "SENT", noticeAttempts: 1 });
    expect(await run("ventas@craftech.io")).toBe("SKIPPED");
    expect(sent).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(EMAIL);
  });

  it("says only what the ADR lists, in Spanish, with the sign-up time in Buenos Aires", async () => {
    await run("ventas@craftech.io");
    const text = sent[0]?.profile === "LEAD_NOTICE" ? sent[0].text : "";
    expect(text).toBe(leadNoticeBody((await leads.get(HASH)) ?? (undefined as never)));
    expect(text).toContain(`Email: ${EMAIL}`);
    expect(text).toContain("Empresa: Despachos del Sur (ficticia)");
    expect(text).not.toContain("Cargo:");
    expect(text).toContain("Idioma: en");
    expect(text).toContain("Acepta que Craftech lo contacte: no (versión 2026-10-02)");
    expect(text).toContain("UTM: source=linkedin");
    expect(text).toContain("Sitio de origen: www.search.example-fict.com");
    expect(artTime("2026-10-14T13:00:00.000Z")).toBe("14/10/2026 10:00 (hora de Buenos Aires)");
  });

  it("`disabled` records DISABLED and sends nothing", async () => {
    expect(await run("disabled")).toBe("DISABLED");
    expect(sent).toEqual([]);
    expect(lines.join("\n")).not.toContain('"metric":"LeadNoticeFailed"');
  });

  it.each([
    ["a subdomain", "ventas@mail.craftech.io"],
    ["a look-alike suffix", "ventas@craftech.io.example-fict.com"],
    ["another domain", "ventas@example-fict.com"],
    ["more than three mailboxes", "a@craftech.io,b@craftech.io,c@craftech.io,d@craftech.io"],
    ["an empty entry", "a@craftech.io,,b@craftech.io"],
  ])("%s: RECIPIENT_NOT_ALLOWED → DISABLED and LeadNoticeFailed, nothing sent", async (_label, secret) => {
    expect(noticeRecipients(secret).status).toBe("RECIPIENT_NOT_ALLOWED");
    expect(await run(secret)).toBe("DISABLED");
    expect(sent).toEqual([]);
    expect(lines.join("\n")).toContain('"metric":"LeadNoticeFailed"');
  });

  it("an SES failure leaves PENDING for the sweep, and the fifth attempt gives up with FAILED", async () => {
    fail = true;
    for (let attempt = 1; attempt < LEAD_NOTICE_MAX_ATTEMPTS; attempt += 1) {
      expect(await run("ventas@craftech.io")).toBe("PENDING");
      expect((await leads.get(HASH))?.noticeAttempts).toBe(attempt);
    }
    expect(await run("ventas@craftech.io")).toBe("FAILED");
    expect(await run("ventas@craftech.io")).toBe("SKIPPED");
  });

  it("no destination address of the notice is written in the code", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const sources = (dir: string): string[] => readdirSync(dir).flatMap((entry) => (statSync(join(dir, entry)).isDirectory() ? sources(join(dir, entry)) : /\.ts$/.test(entry) && !/\.test\.ts$|testing/.test(entry) ? [join(dir, entry)] : []));
    const offenders = sources(root).filter((path) => /[A-Za-z0-9._%+-]+@craftech\.io\b/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
