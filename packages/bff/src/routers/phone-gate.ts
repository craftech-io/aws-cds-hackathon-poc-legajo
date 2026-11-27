// The second factor of every sign-in session (ADR-0021 §2, §14 and §15): until the session of the id
// token passed the SMS code, every procedure is refused with 403 `PHONE_VERIFICATION_REQUIRED`, except
// the phone procedures themselves and the account's language (the screen is written in it). It runs in
// every authenticated entry of trpc.ts: the firm gate (staff and guests with a world), the guest
// bootstrap and the account's own procedures. A principal built on the server for an automation (the
// `QaDriver`) never passes a code; an automation account of Cognito carries the server-side mark of
// phone-verification/records.ts instead.
//
// The operator's block (`blockedAt` of the same item, scripts/console/block.ts) is read first and wins
// over everything: a blocked account gets 403 `ACCOUNT_BLOCKED` in every procedure, the phone ones
// included (no SMS goes out, no code is taken), even with a valid token and a session that already
// passed the code. Only the account's language and the sign-out of the phone session still answer.
import { TRPCError } from "@trpc/server";
import { ERROR_REASON, ToolError } from "@legajo/shared";
import { describeError } from "../auth/errors";
import type { Logger } from "../lib/log";
import { signInSessionId } from "../phone-verification/records";
import type { SessionState } from "../phone-verification/service";
import type { ContextDeps } from "./deps";

/** Procedures that answer while the session has not passed the code. */
export const PHONE_OPEN_PATHS: ReadonlySet<string> = new Set(["account.phoneStatus", "account.sendPhoneCode", "account.verifyPhoneCode", "account.endPhoneSession", "account.preferences"]);

/** Procedures that still answer a blocked account: what the web needs to show the notice and sign out. */
export const BLOCKED_OPEN_PATHS: ReadonlySet<string> = new Set(["account.preferences", "account.endPhoneSession"]);

export const PHONE_REQUIRED_MESSAGE = "enter the code we sent to your mobile phone to continue";
export const ACCOUNT_BLOCKED_MESSAGE = "this account is blocked: write to Craftech";

export interface SessionIdentity {
  readonly sub: string;
  readonly authTime: number;
  readonly originJti?: string;
  readonly automation?: true;
}

export async function assertPhoneCleared(ctx: { readonly deps: ContextDeps; readonly log: Logger }, who: SessionIdentity, path: string): Promise<void> {
  if (who.automation === true || BLOCKED_OPEN_PATHS.has(path)) return;
  let state: SessionState;
  try {
    state = await ctx.deps.phoneGate(who.sub, signInSessionId(who));
  } catch (error) {
    ctx.log.error("console.phone_gate.unavailable", { path, ...describeError(error) });
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "could not check the phone verification", cause: error });
  }
  if (state === "BLOCKED") {
    ctx.log.warn("console.phone_gate.blocked", { path });
    throw new TRPCError({ code: "FORBIDDEN", message: ACCOUNT_BLOCKED_MESSAGE, cause: new ToolError("FORBIDDEN", ACCOUNT_BLOCKED_MESSAGE, ERROR_REASON.ACCOUNT_BLOCKED) });
  }
  if (state === "CLEARED" || PHONE_OPEN_PATHS.has(path)) return;
  ctx.log.info("console.phone_gate.required", { path });
  throw new TRPCError({ code: "FORBIDDEN", message: PHONE_REQUIRED_MESSAGE, cause: new ToolError("FORBIDDEN", PHONE_REQUIRED_MESSAGE, ERROR_REASON.PHONE_VERIFICATION_REQUIRED) });
}
