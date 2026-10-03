// The fence of the public sign-up actions of the `QaDriver` (`signup.readCode`, `lead.inspect`,
// `lead.purge`; docs/test-plan.md §4.1, ADR-0015 §6). They are the only way the driver reaches `Leads`,
// the user pool and the simulated mailboxes' raw MIME, and neither `Leads` (keyed by an HMAC of the
// email) nor Cognito admits an IAM condition on an email prefix, so the fence is this code:
//
//   1. no action receives an email: it receives a `key` (`a`, `b`, …) and the mailbox is built here as
//      `qa-signup-<runId>-<key>@sim.legajo.demo.craftech.io`, with the run id of the call's own
//      idempotency key, so a call can only ever name a mailbox of its own run;
//   2. every access to a lead, an account or a mail goes through `assertSignupMailbox` first: an
//      address that is not exactly such a mailbox is FORBIDDEN `QA_FENCE` before any read or write.
import { SIM_MAIL_DOMAIN, ToolError } from "@legajo/shared";
import { QA_SIGNUP_MAILBOX } from "../signup/bot-checks";
import { QA_REASON, RunId } from "./contract";
import { SignupKey } from "./contract-inputs";

export const QA_SIGNUP_PREFIX = "qa-signup-";

function fenced(message: string): ToolError {
  return new ToolError("FORBIDDEN", message, QA_REASON.QA_FENCE);
}

/** The run of a call: the first segment of its idempotency key (`<runId>/<scenario>/<step>[/<label>]`). */
export function runOfKey(idempotencyKey: string): string {
  const runId = idempotencyKey.split("/")[0] ?? "";
  if (!RunId.safeParse(runId).success) throw fenced("the call's key names no run");
  return runId;
}

/** `qa-signup-<runId>-<key>@sim…`: the only mailbox a sign-up action of this call may touch. */
export function signupMailbox(idempotencyKey: string, key: string): string {
  if (!SignupKey.safeParse(key).success) throw new ToolError("INVALID", "a sign-up key is a short lower-case key");
  return `${QA_SIGNUP_PREFIX}${runOfKey(idempotencyKey)}-${key}@${SIM_MAIL_DOMAIN}`;
}

/**
 * True only for exactly `qa-signup-<run>-<key>@sim.legajo.demo.craftech.io` (lower case, one `@`, the
 * simulated domain itself, never a subdomain or a longer name).
 */
export function isSignupMailbox(address: string): boolean {
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@")) return false;
  const local = address.slice(0, at);
  return address.slice(at + 1) === SIM_MAIL_DOMAIN && local.startsWith(QA_SIGNUP_PREFIX) && QA_SIGNUP_MAILBOX.test(local);
}

/** Before every read or write of a lead, an account or a mail: the address is a sign-up mailbox of this run. */
export function assertSignupMailbox(address: string, idempotencyKey: string): void {
  if (!isSignupMailbox(address)) throw fenced("the QA driver only touches the qa-signup-* mailboxes of SC-26");
  if (!address.startsWith(`${QA_SIGNUP_PREFIX}${runOfKey(idempotencyKey)}-`)) throw fenced("a sign-up mailbox of another run");
}
