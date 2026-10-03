// Local flows of the public sign-up (docs/flows-catalog.md, area J; ADR-0015 §1 to §3): the real BFF
// entry with Function URL events as CloudFront forwards them, `SignupDispatch` and `LeadNotice` run in
// process, the Cognito double that checks the ticket the way `AuthPreSignUp` does, and the account
// emails' SES events through the real `ChannelEvents` entry (support/public.ts). Real time is the
// machine's at the start of each test (the id tokens are checked against it) and moves only when the
// test moves it. Every email is an invented one.
import { leadEmailHash } from "@legajo/bff/lib/crypto";
import { cognitoWrites } from "@legajo/bff/signup/testing";
import { describe, expect, it } from "vitest";
import { useFlowWorld } from "./support/lifecycle";
import { LOCAL_NOTICE_TO, createPublicEdge } from "./support/public";
import { sesEventOf } from "./support/stage/mailroom";

const worlds = useFlowWorld();

async function edge() {
  const flow = await worlds.open({}, { realNow: new Date().toISOString() });
  return { flow, edge: createPublicEdge(flow) };
}

const EMAIL = "ana.perez@estudio-ficticio.com.ar";
const statusOf = (answer: { readonly data: unknown }) => (answer.data as { status?: string } | undefined)?.status;
const leadOf = async (access: ReturnType<typeof createPublicEdge>["access"], email: string) => access.leads.get(leadEmailHash(access.keys.leadEmail, email));
const usersOf = (access: ReturnType<typeof createPublicEdge>["access"], email: string) => [...access.cognito.users.values()].filter((user) => user.email === email);

describe("public sign-up flows", () => {
  it("[FL-101] a new email signs up end to end: start → SignupDispatch → code → confirm → GUEST group, verified lead with its consents and the notice to Craftech", async () => {
    const { flow, edge: api } = await edge();

    const started = await api.startSignup(EMAIL);

    expect(started.start).toMatchObject({ status: 200, data: { status: "CODE_SENT" } });
    expect(api.access.cognito.codes.map((sent) => sent.kind)).toEqual(["SIGNUP"]);
    expect(await leadOf(api.access, EMAIL)).toBeUndefined();

    const confirmed = await api.confirm(started.signupId, EMAIL);

    expect(statusOf(confirmed)).toBe("CONFIRMED");
    const [user] = usersOf(api.access, EMAIL);
    expect(user).toMatchObject({ status: "CONFIRMED", groups: ["GUEST"] });
    const lead = await leadOf(api.access, EMAIL);
    expect(lead).toMatchObject({ email: EMAIL, language: "es", consents: { terms: { accepted: true, version: api.access.legalVersions.terms }, contact: { accepted: true } }, noticeStatus: "SENT" });
    expect(lead?.confirmedAt).toBeDefined();
    const notices = flow.aws.sesMessages.filter((sent) => sent.input.Destination?.ToAddresses?.includes(LOCAL_NOTICE_TO));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.input.Content?.Simple?.Body?.Text?.Data).toContain(EMAIL);
  });

  it("[FL-102] wrong codes count down to EXPIRED; the expired sign-up confirms nothing and a new one from /signup works", async () => {
    const { edge: api } = await edge();
    const started = await api.startSignup(EMAIL);

    const attempts: Array<string | undefined> = [];
    for (let attempt = 0; attempt < 5; attempt += 1) attempts.push(statusOf(await api.confirm(started.signupId, EMAIL, "000001")));

    expect(attempts).toEqual(["CODE_INVALID", "CODE_INVALID", "CODE_INVALID", "CODE_INVALID", "EXPIRED"]);
    expect(statusOf(await api.confirm(started.signupId, EMAIL))).toBe("EXPIRED");
    expect(await leadOf(api.access, EMAIL)).toBeUndefined();

    const again = await api.startSignup(EMAIL, { viewer: "198.51.100.20:40001" });
    expect(again.signupId).not.toBe(started.signupId);
    expect(statusOf(await api.confirm(again.signupId, EMAIL))).toBe("CONFIRMED");
    expect(await leadOf(api.access, EMAIL)).toBeDefined();
  });

  it("[FL-103] resend in the NEW branch mails a new code (the old one no longer works), in EXISTING_GUEST it goes through ForgotPassword with intent signup-existing, and a SUPPRESSED sign-up calls nothing", async () => {
    const { flow, edge: api } = await edge();
    const started = await api.startSignup(EMAIL);
    const firstCode = api.codeOf(EMAIL) ?? "";
    flow.advanceReal(61_000);

    expect(statusOf(await api.api("POST", "signup.resend", { signupId: started.signupId }))).toBe("CODE_SENT");
    await api.settle();
    expect(api.access.cognito.codes.map((sent) => sent.kind)).toEqual(["SIGNUP", "RESEND"]);
    expect(statusOf(await api.confirm(started.signupId, EMAIL, firstCode === api.codeOf(EMAIL) ? "000002" : firstCode))).toBe("CODE_INVALID");
    expect(statusOf(await api.confirm(started.signupId, EMAIL))).toBe("CONFIRMED");

    const existing = await api.startSignup(EMAIL, { viewer: "198.51.100.21:40002" });
    flow.advanceReal(61_000);
    await api.api("POST", "signup.resend", { signupId: existing.signupId });
    await api.settle();
    const forgot = api.access.cognito.codes.filter((sent) => sent.kind === "FORGOT");
    expect(forgot.length).toBeGreaterThanOrEqual(2);
    expect(forgot.every((sent) => sent.clientMetadata.intent === "signup-existing")).toBe(true);

    const bot = await api.startSignup("bot.persona@estudio-ficticio.com.ar", { website: "https://spam.example.net", viewer: "198.51.100.22:40003" });
    const calls = api.access.cognito.calls.length;
    flow.advanceReal(61_000);
    expect(statusOf(await api.api("POST", "signup.resend", { signupId: bot.signupId }))).toBe("CODE_SENT");
    await api.settle();
    expect(cognitoWrites(api.access.cognito.calls.slice(calls))).toEqual([]);
  });

  it("[FL-104] the four branches answer the same CODE_SENT: NEW creates one user, EXISTING_GUEST reuses it, an internal account is INELIGIBLE and gets nothing, a bot is SUPPRESSED; one user and one lead per email", async () => {
    const { edge: api } = await edge();
    api.access.cognito.seed({ username: "staff-diego", email: "diego.staff@estudio-ficticio.com.ar", groups: ["BROKER"], firmId: "firm-delta" });

    const fresh = await api.signUp(EMAIL);
    const again = await api.startSignup(EMAIL, { viewer: "198.51.100.23:40004" });
    const staff = await api.startSignup("diego.staff@estudio-ficticio.com.ar", { viewer: "198.51.100.24:40005" });
    const bot = await api.startSignup("otra.persona@estudio-ficticio.com.ar", { website: "x", viewer: "198.51.100.25:40006" });

    for (const answer of [again.start, staff.start, bot.start]) expect(answer).toMatchObject({ status: 200, data: { status: "CODE_SENT" } });
    expect(fresh.username).toBeDefined();
    expect(usersOf(api.access, EMAIL)).toHaveLength(1);
    expect(usersOf(api.access, "diego.staff@estudio-ficticio.com.ar")).toHaveLength(1);
    expect(usersOf(api.access, "otra.persona@estudio-ficticio.com.ar")).toEqual([]);
    expect((await api.access.signups.get(staff.signupId, api.access.now()))?.branch).toBe("INELIGIBLE");
    expect((await api.access.signups.get(bot.signupId, api.access.now()))?.branch).toBe("SUPPRESSED");
    expect((await api.access.signups.get(again.signupId, api.access.now()))?.branch).toBe("EXISTING_GUEST");
    expect(await leadOf(api.access, "diego.staff@estudio-ficticio.com.ar")).toBeUndefined();
    expect(await leadOf(api.access, "otra.persona@estudio-ficticio.com.ar")).toBeUndefined();
  });

  it("[FL-112] the fourth signup.start for one email in 24 hours answers CODE_SENT without an email or a user", async () => {
    const { edge: api } = await edge();
    for (let attempt = 0; attempt < 3; attempt += 1) await api.startSignup(EMAIL, { viewer: `198.51.100.${30 + attempt}:4100${attempt}` });
    const before = { codes: api.access.cognito.codes.length, calls: api.access.cognito.calls.length };

    const fourth = await api.startSignup(EMAIL, { viewer: "198.51.100.40:41010" });

    expect(fourth.start).toMatchObject({ status: 200, data: { status: "CODE_SENT" } });
    expect(api.access.cognito.codes).toHaveLength(before.codes);
    expect(cognitoWrites(api.access.cognito.calls.slice(before.calls))).toEqual([]);
    expect((await api.access.signups.get(fourth.signupId, api.access.now()))?.branch).toBe("SUPPRESSED");
  });

  it("[FL-113] a filled honeypot leaves the SIGNUP# SUPPRESSED and no SignUp reaches Cognito", async () => {
    const { edge: api } = await edge();

    const bot = await api.startSignup(EMAIL, { website: "https://spam.example.net" });

    expect(bot.start).toMatchObject({ status: 200, data: { status: "CODE_SENT" } });
    expect((await api.access.signups.get(bot.signupId, api.access.now()))?.branch).toBe("SUPPRESSED");
    expect(api.access.cognito.calls).not.toContain("signUp");
    expect(usersOf(api.access, EMAIL)).toEqual([]);
  });

  it("[FL-114] a permanent bounce of a sign-up that was never confirmed is kept in MAILSTATUS# and the next sign-up to that email is suppressed", async () => {
    const { flow, edge: api } = await edge();
    await api.startSignup(EMAIL);

    const status = await flow.entries.channelEvent(sesEventOf({ messageId: "cognito-account-mail-0001", input: { FromEmailAddress: "no-reply@legajo.demo.craftech.io", Destination: { ToAddresses: [EMAIL] }, Content: {} } }, "Bounce", flow.realNow()));
    expect(status).toMatchObject({ status: "ACCOUNT_MAIL_MARKED" });
    const mailStatus = flow.stores.client.dump("Runtime").filter((row) => String(row.PK).startsWith("MAILSTATUS#"));
    expect(mailStatus).toHaveLength(1);
    expect(JSON.stringify(mailStatus)).not.toContain(EMAIL);
    flow.advanceReal(2 * 3_600_000);

    const next = await api.startSignup(EMAIL, { viewer: "198.51.100.50:42000" });

    expect(next.start).toMatchObject({ status: 200, data: { status: "CODE_SENT" } });
    expect((await api.access.signups.get(next.signupId, api.access.now()))?.branch).toBe("SUPPRESSED");
  });

  it("[FL-119] (b) terms only and (c) terms and contact give a lead whose contact consent says what was ticked, each with its version", async () => {
    const { edge: api } = await edge();

    await api.signUp("sin.contacto@estudio-ficticio.com.ar", { contact: false, viewer: "198.51.100.60:43000" });
    await api.signUp("con.contacto@estudio-ficticio.com.ar", { contact: true, viewer: "198.51.100.61:43001" });

    expect((await leadOf(api.access, "sin.contacto@estudio-ficticio.com.ar"))?.consents).toMatchObject({ terms: { accepted: true, version: api.access.legalVersions.terms, privacyVersion: api.access.legalVersions.privacy }, contact: { accepted: false } });
    expect((await leadOf(api.access, "con.contacto@estudio-ficticio.com.ar"))?.consents).toMatchObject({ terms: { accepted: true }, contact: { accepted: true, version: api.access.legalVersions.contact } });
  });

  it("[FL-120] a sign-up in English: Cognito locale en, consents with lang en, the lead in English and the notice to Craftech in Spanish", async () => {
    const { flow, edge: api } = await edge();

    await api.signUp(EMAIL, { lang: "en" });

    expect(usersOf(api.access, EMAIL)[0]?.locale).toBe("en");
    expect(await leadOf(api.access, EMAIL)).toMatchObject({ language: "en", consents: { terms: { lang: "en" }, contact: { lang: "en" } } });
    const notice = flow.aws.sesMessages.find((sent) => sent.input.Destination?.ToAddresses?.includes(LOCAL_NOTICE_TO));
    expect(notice?.input.Content?.Simple?.Subject?.Data).toMatch(/Nuevo registro/);
  });
});
