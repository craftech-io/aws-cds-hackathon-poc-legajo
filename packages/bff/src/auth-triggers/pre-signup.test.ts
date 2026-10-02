// AuthPreSignUp (ADR-0015 §1): only a SignUp with the ticket SignupDispatch made for this user and
// email creates a user; a direct SignUp, a stale or foreign ticket and an external provider are refused
// before the user exists and before any email; the operator's AdminCreateUser passes.
import { describe, expect, it } from "vitest";
import { leadEmailHash } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { testSignupKeys } from "../signup/testing";
import { issueTicket } from "../signup/ticket";
import { createPreSignUpHandler } from "./pre-signup";

const keys = testSignupKeys();
const NOW = new Date("2026-10-14T13:30:00.000Z");
const USERNAME = "usr-01j9zqxa7q2w3e4r5t6y7v8h9g";
const EMAIL = "ana.gomez@despachos-del-sur.com.ar";
const SIGNUP_ID = "01J9ZQXA7Q2W3E4R5T6Y7V8H9G";

function run(event: unknown, now = NOW) {
  const lines: string[] = [];
  const handler = createPreSignUpHandler(() => ({ ticketKey: () => keys.ticket, leadEmailKey: () => keys.leadEmail, now: () => now, log: createLogger({ level: "debug", sink: (line) => lines.push(line) }) }));
  return { result: handler(event), lines };
}

function event(triggerSource: string, validationData?: Record<string, string>, email = EMAIL) {
  return {
    version: "1",
    triggerSource,
    region: "us-east-1",
    userPoolId: "us-east-1_TESTPOOL1",
    userName: USERNAME,
    callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "test-web-client" },
    request: { userAttributes: { email, locale: "es" }, ...(validationData === undefined ? {} : { validationData }) },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  };
}

const ticket = (at = NOW, email = EMAIL) => ({ ...issueTicket(keys.ticket, { username: USERNAME, emailHash: leadEmailHash(keys.leadEmail, email), signupId: SIGNUP_ID }, at) });

describe("[FL-101] PreSignUp_SignUp with SignupDispatch's ticket", () => {
  it("is accepted, without confirming the user or verifying the email", async () => {
    const result = (await run(event("PreSignUp_SignUp", ticket())).result) as { response: Record<string, boolean> };
    expect(result.response).toEqual({ autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false });
  });
});

describe("[FL-113] anything else creates nothing", () => {
  it.each([
    ["no ticket (a SignUp straight on the public client)", undefined, NOW, EMAIL],
    ["an expired ticket (more than 120 s)", ticket(new Date(NOW.getTime() - 121_000)), NOW, EMAIL],
    ["the ticket of another email", ticket(NOW, "otra@despachos-del-sur.com.ar"), NOW, EMAIL],
    ["an altered ticket", { ...ticket(), ticket: "AAAA" }, NOW, EMAIL],
  ])("%s", async (_label, data, now, email) => {
    const { result, lines } = run(event("PreSignUp_SignUp", data, email), now);
    await expect(result).rejects.toThrow("the sign-up was refused");
    expect(lines.join("\n")).toContain('"metric":"SignupRejected"');
    expect(lines.join("\n")).not.toContain(EMAIL);
  });

  it("an external provider is refused; the operator's AdminCreateUser passes", async () => {
    await expect(run(event("PreSignUp_ExternalProvider")).result).rejects.toThrow();
    await expect(run(event("PreSignUp_AdminCreateUser")).result).resolves.toMatchObject({ response: { autoConfirmUser: false } });
  });

  it("an event of another shape is refused", async () => {
    await expect(run({ triggerSource: "PreSignUp_SignUp" }).result).rejects.toThrow();
  });
});
