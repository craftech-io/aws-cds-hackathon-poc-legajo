import { describe, expect, it } from "vitest";
import { SIGNUP_FORM_MAX_SECONDS, SIGNUP_TICKET_TTL_SECONDS } from "@legajo/shared/guest-limits";
import { leadEmailHash } from "../lib/crypto";
import { testSignupKeys } from "./testing";
import { formShownAt, issueFormToken, issueTicket, verifyTicket } from "./ticket";

const keys = testSignupKeys();
const NOW = new Date("2026-10-14T13:30:00.000Z");
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const subject = { username: "usr-01j9zqxa7q2w3e4r5t6y7v8h9g", emailHash: leadEmailHash(keys.leadEmail, "ana@example-fict.com.ar"), signupId: "01J9ZQXA7Q2W3E4R5T6Y7V8H9G" };

describe("[FL-101] sign-up ticket (ADR-0015 §1)", () => {
  it("is valid for its user, email and sign-up for 120 s", () => {
    const ticket = issueTicket(keys.ticket, subject, NOW);
    expect(Number(ticket.exp)).toBe(Math.floor(NOW.getTime() / 1000) + SIGNUP_TICKET_TTL_SECONDS);
    expect(verifyTicket(keys.ticket, subject, { ...ticket }, NOW)).toBe("VALID");
    expect(verifyTicket(keys.ticket, subject, { ...ticket }, later(SIGNUP_TICKET_TTL_SECONDS))).toBe("VALID");
  });

  it("[FL-113] an expired, altered, foreign or missing ticket is refused", () => {
    const ticket = issueTicket(keys.ticket, subject, NOW);
    expect(verifyTicket(keys.ticket, subject, { ...ticket }, later(SIGNUP_TICKET_TTL_SECONDS + 1))).toBe("EXPIRED");
    expect(verifyTicket(keys.ticket, subject, { ...ticket, exp: String(Number(ticket.exp) + 60) }, NOW)).toBe("INVALID");
    expect(verifyTicket(keys.ticket, subject, { ...ticket, ticket: `${ticket.ticket.slice(0, -1)}A` }, NOW)).toBe("INVALID");
    expect(verifyTicket(keys.ticket, { ...subject, emailHash: leadEmailHash(keys.leadEmail, "otra@example-fict.com.ar") }, { ...ticket }, NOW)).toBe("INVALID");
    expect(verifyTicket(keys.ticket, { ...subject, username: "usr-01j9zqxa7q2w3e4r5t6y7v8h90" }, { ...ticket }, NOW)).toBe("INVALID");
    expect(verifyTicket(keys.ticket, subject, { ...ticket, signupId: "01J9ZQXA7Q2W3E4R5T6Y7V8H90" }, NOW)).toBe("INVALID");
    expect(verifyTicket(keys.form, subject, { ...ticket }, NOW)).toBe("INVALID");
    expect(verifyTicket(keys.ticket, subject, undefined, NOW)).toBe("MISSING");
    expect(verifyTicket(keys.ticket, subject, { signupId: subject.signupId, exp: ticket.exp }, NOW)).toBe("MISSING");
    // A ticket minted with a longer life is not one of ours.
    const far = issueTicket(keys.ticket, subject, later(3_600));
    expect(verifyTicket(keys.ticket, subject, { ...far }, NOW)).toBe("INVALID");
  });
});

describe("[FL-113] form token (when the form was shown)", () => {
  it("round-trips the instant and the language, and refuses anything else", () => {
    const token = issueFormToken(keys.form, "en", NOW);
    expect(formShownAt(keys.form, token)?.toISOString()).toBe(NOW.toISOString());
    expect(formShownAt(keys.ticket, token)).toBeUndefined();
    expect(formShownAt(keys.form, token.replace(".en.", ".es."))).toBeUndefined();
    expect(formShownAt(keys.form, `${String(NOW.getTime() - SIGNUP_FORM_MAX_SECONDS * 1000)}.es.forged`)).toBeUndefined();
    expect(formShownAt(keys.form, "garbage")).toBeUndefined();
  });
});
