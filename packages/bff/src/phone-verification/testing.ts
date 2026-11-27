// Test helpers of the SMS code (ADR-0021): the account of a token and a whole enrolment over the
// in-memory SMS sender of signup/testing.ts. No test sends a real SMS.
import { createLogger } from "../lib/log";
import type { TestAccess } from "../signup/testing";
import { type PhoneAccount, sendPhoneCode, verifyPhoneCode } from "./service";

const quiet = createLogger({ level: "error" });

export function phoneAccount(overrides: Partial<PhoneAccount> & Pick<PhoneAccount, "username">): PhoneAccount {
  return { sub: `sub-${overrides.username}`, sessionId: "jti-1", lang: "es", ipHash: "ip-a", ...overrides };
}

/** Sends the code (to `phone`, or the sign-up's number) and types the right one; the last answer. */
export async function passPhoneCode(access: TestAccess, account: PhoneAccount, phone?: string) {
  const sent = await sendPhoneCode(access, account, phone, quiet);
  if (sent.status !== "CODE_SENT") return sent;
  const code = access.sms.sent.at(-1)?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
  return verifyPhoneCode(access, account, code, quiet);
}
