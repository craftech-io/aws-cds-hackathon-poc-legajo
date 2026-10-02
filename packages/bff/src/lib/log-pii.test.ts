// FL-121: what a visitor types into the sign-up form never reaches a log line, whichever handler logs
// it and however deep it is nested (ADR-0015 §6, "PII").
import { describe, expect, it } from "vitest";
import { MASK, createLogger } from "./log";

const LEAD = {
  email: "ana.gomez@example-fict.com.ar",
  password: "Quince-Caballos-7",
  passwordSealed: "v1.aXY.Ym9keQ.dGFn",
  name: "Ana Gómez",
  company: "Despachos del Sur",
  jobTitle: "Jefa de operaciones",
  website: "https://spam.example",
  referrer: "https://www.search.example",
  utm: { source: "linkedin", campaign: "otoño" },
  ticket: "c2lnbmVkLXRpY2tldA",
  formToken: "Zm9ybS10b2tlbg",
};

function logged(fields: Record<string, unknown>, message = "signup.start"): string {
  const lines: string[] = [];
  createLogger({ level: "debug", sink: (line) => lines.push(line), bindings: { service: "signup" } }).info(message, fields);
  return lines.join("\n");
}

describe("[FL-121] lead data never reaches a log line", () => {
  it("redacts every field of the form at the top level", () => {
    const line = logged({ ...LEAD, signupId: "01J9ZQXA7Q2W3E4R5T6Y7V8H9G", branch: "NEW" });
    for (const value of [LEAD.email, LEAD.password, LEAD.passwordSealed, LEAD.name, LEAD.company, LEAD.jobTitle, LEAD.website, LEAD.referrer, "linkedin", LEAD.ticket, LEAD.formToken]) {
      expect(line).not.toContain(value);
    }
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record).toMatchObject({ email: MASK.email, password: MASK.omitted, passwordSealed: MASK.omitted, name: MASK.name, company: MASK.redacted, jobTitle: MASK.redacted, signupId: "01J9ZQXA7Q2W3E4R5T6Y7V8H9G", branch: "NEW" });
  });

  it("redacts them nested in an item, an array or an error, and masks an email inside free text", () => {
    const line = logged({ item: { lead: LEAD }, items: [LEAD], error: new Error(`could not send to ${LEAD.email}`) }, `notice for ${LEAD.email} failed`);
    for (const value of [LEAD.email, LEAD.password, LEAD.name, LEAD.company, LEAD.jobTitle]) expect(line).not.toContain(value);
    expect(line).toContain(MASK.email);
  });

  it("keeps what the sign-up logs on purpose: ids, branches, reasons and counts", () => {
    const record = JSON.parse(logged({ reason: "EMAIL_QUOTA", metric: "SignupRejected", dispatchSeq: 2, attempts: 3 })) as Record<string, unknown>;
    expect(record).toMatchObject({ reason: "EMAIL_QUOTA", metric: "SignupRejected", dispatchSeq: 2, attempts: 3 });
  });
});
