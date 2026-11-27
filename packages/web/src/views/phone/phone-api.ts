// The four phone procedures of the session (`account.phoneStatus`, `account.sendPhoneCode`,
// `account.verifyPhoneCode`, `account.endPhoneSession`; ADR-0021), validated with the shared contract on
// the way back, through the untyped client like the other access calls (views/auth/signup-api.ts).
import { PhoneStatusOutput, SendPhoneCodeOutput, VerifyPhoneCodeOutput } from "@legajo/shared/phone-verification";
import { getUntypedClient } from "@trpc/client";
import type { ConsoleClient } from "../../lib/trpc";

export async function fetchPhoneStatus(trpc: ConsoleClient): Promise<PhoneStatusOutput> {
  return PhoneStatusOutput.parse(await getUntypedClient(trpc).query("account.phoneStatus", undefined));
}

export async function sendPhoneCode(trpc: ConsoleClient, phone?: string): Promise<SendPhoneCodeOutput> {
  return SendPhoneCodeOutput.parse(await getUntypedClient(trpc).mutation("account.sendPhoneCode", phone === undefined ? {} : { phone }));
}

export async function verifyPhoneCode(trpc: ConsoleClient, code: string): Promise<VerifyPhoneCodeOutput> {
  return VerifyPhoneCodeOutput.parse(await getUntypedClient(trpc).mutation("account.verifyPhoneCode", { code }));
}
