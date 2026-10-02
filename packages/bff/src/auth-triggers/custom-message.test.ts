// AuthCustomMessage (ADR-0015 §3.2 and §7): the account email in the user's language, and the cuts that
// keep account emails from mailing third parties or hurting the account's reputation. A cut is a
// failing trigger: Cognito sends nothing.
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_EMAIL_LIMITS } from "@legajo/shared/guest-limits";
import { MAIL_BREAKER_KEY, mailStatusKey } from "../channels/email/mail-status";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { leadEmailHash } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { RUNTIME_TABLE } from "../signup/counters";
import { testSignupKeys } from "../signup/testing";
import { createCustomMessageHandler } from "./custom-message";

const keys = testSignupKeys();
const NOW = new Date("2026-10-14T13:20:00.000Z");
const EMAIL = "ana.gomez@despachos-del-sur.com.ar";
let stores: MemoryStores;
let lines: string[];

beforeEach(() => {
  stores = memoryStores();
  lines = [];
});

function handler() {
  return createCustomMessageHandler(() => ({ client: stores.client, leadEmailKey: () => keys.leadEmail, rateKey: () => keys.rate, now: () => NOW, log: createLogger({ level: "debug", sink: (line) => lines.push(line) }) }));
}

function event(triggerSource: string, options: { email?: string; locale?: string; metadata?: Record<string, string> } = {}) {
  return {
    version: "1",
    triggerSource,
    region: "us-east-1",
    userPoolId: "us-east-1_TESTPOOL1",
    userName: "usr-01j9zqxa7q2w3e4r5t6y7v8h9g",
    callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "test-web-client" },
    request: {
      userAttributes: { email: options.email ?? EMAIL, ...(options.locale === undefined ? {} : { locale: options.locale }) },
      codeParameter: "{####}",
      usernameParameter: "{username}",
      ...(options.metadata === undefined ? {} : { clientMetadata: options.metadata }),
    },
    response: { smsMessage: null, emailMessage: null, emailSubject: null },
  };
}

type Written = { response: { emailSubject: string; emailMessage: string } };
const send = async (source: string, options?: Parameters<typeof event>[1]) => (await handler()(event(source, options))) as Written;

async function bounced(email: string): Promise<void> {
  await stores.client.put(RUNTIME_TABLE, { ...mailStatusKey(leadEmailHash(keys.leadEmail, email)), entity: "MailStatus", status: "BOUNCED", at: NOW.toISOString(), count: 1 });
}

describe("[FL-104] the account emails, by trigger and intent", () => {
  it("the sign-up code, and 'you already have an account' for a ForgotPassword with intent signup-existing", async () => {
    expect((await send("CustomMessage_SignUp")).response.emailSubject).toBe("Tu código para Legajo listo");
    const existing = await send("CustomMessage_ForgotPassword", { metadata: { intent: "signup-existing", lang: "es" } });
    expect(existing.response.emailSubject).toBe("Ya tenés una cuenta en Legajo listo");
    expect(existing.response.emailMessage).toContain("{####}");
    const english = await send("CustomMessage_ForgotPassword", { locale: "en", metadata: { intent: "signup-existing" } });
    expect(english.response.emailSubject).toBe("You already have a Legajo listo account");
  });
});

describe("[FL-107] recovery", () => {
  it("writes the recovery email in the user's locale, with the code", async () => {
    const written = await send("CustomMessage_ForgotPassword", { locale: "en" });
    expect(written.response.emailSubject).toBe("Change your Legajo listo password");
    expect(written.response.emailMessage).toContain("{####}");
  });
});

describe("[FL-114] quotas of account emails", () => {
  it("cuts the sixth email of a day to one recipient, counting the sign-up's own", async () => {
    const perRecipient = ACCOUNT_EMAIL_LIMITS.perRecipient[0].limit;
    await send("CustomMessage_SignUp");
    for (let index = 1; index < perRecipient; index += 1) await send("CustomMessage_ResendCode");
    await expect(handler()(event("CustomMessage_ResendCode"))).rejects.toThrow("the account email was not sent");
    await expect(handler()(event("CustomMessage_ForgotPassword"))).rejects.toThrow();
    expect(lines.join("\n")).toContain('"metric":"AccountMailBlocked"');
    expect(lines.join("\n")).not.toContain(EMAIL);
    // Another recipient of the same domain still gets its email.
    await expect(send("CustomMessage_ResendCode", { email: "otra@despachos-del-sur.com.ar" })).resolves.toBeDefined();
  });

  it("cuts every email to a recipient that bounced or complained, the sign-up's too; never an invitation", async () => {
    await bounced(EMAIL);
    for (const source of ["CustomMessage_SignUp", "CustomMessage_ResendCode", "CustomMessage_ForgotPassword", "CustomMessage_VerifyUserAttribute"]) {
      await expect(handler()(event(source)), source).rejects.toThrow();
    }
    await expect(send("CustomMessage_AdminCreateUser")).resolves.toMatchObject({ response: { emailSubject: "Tu acceso a Legajo listo" } });
  });

  it("with the breaker open, only the operator's invitations go out", async () => {
    await stores.client.put(RUNTIME_TABLE, { ...MAIL_BREAKER_KEY, entity: "MailBreaker", state: "OPEN", openedAt: NOW.toISOString() });
    await expect(handler()(event("CustomMessage_SignUp"))).rejects.toThrow();
    await expect(handler()(event("CustomMessage_ResendCode"))).rejects.toThrow();
    const invitation = await send("CustomMessage_AdminCreateUser");
    expect(invitation.response.emailMessage).toContain("{username}");
    expect(invitation.response.emailMessage).toContain("{####}");
  });

  it("the total of the day closes past its limit for resends, while SignUp only counts", async () => {
    const total = ACCOUNT_EMAIL_LIMITS.total[0].limit;
    await stores.client.update(RUNTIME_TABLE, { PK: `RL#MAIL#TOTAL#${NOW.toISOString().slice(0, 10)}`, SK: "META" }, { set: { count: total, expiresAt: 0 } }, NOW.toISOString(), { upsert: true });
    await expect(handler()(event("CustomMessage_ResendCode", { email: "x@despachos-del-sur.com.ar" }))).rejects.toThrow();
    await expect(send("CustomMessage_SignUp", { email: "y@despachos-del-sur.com.ar" })).resolves.toBeDefined();
  });

  it("an unknown trigger source is cut", async () => {
    await expect(handler()(event("CustomMessage_Authentication"))).rejects.toThrow();
  });
});
