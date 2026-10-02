// Test-only drivers of the sign-up (never imported by runtime code): a form as the page sends it, and
// `signup.start` followed by the asynchronous `SignupDispatch` it queued, run in process the way the
// Lambda would. Used by the unit tests of signup/, routers/ and janitor/ and by the local flows.
import { SignupStartInput, type SignupStartInput as SignupStartForm, type SignupStartOutput } from "@legajo/shared/signup";
import { createLogger, type Logger } from "../lib/log";
import { runDispatch } from "./dispatch";
import { signupStart } from "./service";
import type { TestAccess } from "./testing";
import { issueFormToken } from "./ticket";

export const TEST_PASSWORD = "Quince-Caballos-7";
const quiet = createLogger({ level: "error" });

/** The sign-up form filled by a person who took 10 s, with the texts in force. */
export function validForm(access: TestAccess, overrides: Partial<SignupStartForm> = {}): SignupStartForm {
  const shown = new Date(access.now().getTime() - 10_000);
  return {
    formToken: issueFormToken(access.keys.form, overrides.lang ?? "es", shown),
    email: "ana.gomez@despachos-del-sur.com.ar",
    password: TEST_PASSWORD,
    consents: { terms: true, contact: true },
    consentVersions: { ...access.legalVersions },
    lang: "es",
    website: "",
    ...overrides,
  };
}

/** Runs every `SignupDispatch` event queued so far, once, as the Lambda would. */
export async function drainDispatch(access: TestAccess, log: Logger = quiet): Promise<void> {
  const ran = drained.get(access) ?? 0;
  const pending = access.invoker.invoked.filter((call) => call.target === "SignupDispatch").slice(ran);
  drained.set(access, ran + pending.length);
  for (const call of pending) await runDispatch(access, call.payload, log);
}

const drained = new WeakMap<TestAccess, number>();

export interface StartedSignup {
  readonly answer: SignupStartOutput;
  readonly signupId: string;
}

/** `signup.start` from viewer `ipHash`, then its dispatch. */
export async function startSignup(access: TestAccess, overrides: Partial<SignupStartForm> = {}, ipHash = "ip-test", log: Logger = quiet): Promise<StartedSignup> {
  const answer = await signupStart(access, SignupStartInput.parse(validForm(access, overrides)), { ipHash, log });
  await drainDispatch(access, log);
  return { answer, signupId: answer.status === "CODE_SENT" ? answer.signupId : "" };
}
