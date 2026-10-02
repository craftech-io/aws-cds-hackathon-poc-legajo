// `SignupDispatch` (ADR-0015 §1, §1.1 and §1.2): the only code that calls Cognito to create a sign-up,
// out of the path of the visitor's answer, so no branch shows in the time or the shape of a response.
// Asynchronous, without Lambda retries, idempotent by `dispatchSeq`; it never writes a lead and never
// invokes `LeadNotice` (§1.4).
//
// START   1 claims the event and removes the sealed password (every branch, first step)
//         2 suppresses: honeypot or form time, reserved/own/no-MX domain, bounce status, open breaker,
//           too many sign-ups of the email or of the domain
//         3 classifies the email (ListUsers, AdminGetUser, AdminListGroupsForUser; signup/classify.ts)
//           and acts: SignUp with the ticket | delete the UNCONFIRMED user and SignUp | ForgotPassword
//           (`intent signup-existing`) | nothing
//         4 records the branch (only while `dispatchSeq` is still its own)
// RESEND  a sign-up whose START never ran (dropped as stale by this resend, or never invoked) still
//         has its sealed password: the resend runs exactly as START, with every suppression. Else by
//         the recorded branch: ResendConfirmationCode | ForgotPassword | nothing; a sign-up whose
//         dispatch failed is classified again (it has no password any more: only codes are resent).
import { z } from "zod";
import { SignupId, type SignupBranch, type SignupRejectReason } from "@legajo/shared/signup";
import { countMetric } from "../channels/adapter";
import { isBreakerOpen, readMailStatus } from "../channels/email/mail-status";
import { type SecretKey, hmacSha256Hex, mailboxQuotaHash, openSealed } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { PendingSignup } from "../leads/lead";
import { checkMx, domainOf, domainSuppression, formSuppression } from "./bot-checks";
import { type Classification, type FoundUser, classifyExisting } from "./classify";
import type { CognitoUser } from "./cognito";
import type { AccessDeps } from "./deps";
import { gateEmail } from "./rate-limits";
import { issueTicket } from "./ticket";

export const DispatchEvent = z.object({ kind: z.enum(["START", "RESEND"]), signupId: SignupId, dispatchSeq: z.number().int().min(1) }).strict();
export type DispatchEvent = z.infer<typeof DispatchEvent>;

export const SIGNUP_METRICS = {
  started: "SignupStarted",
  confirmed: "SignupConfirmed",
  rejected: "SignupRejected",
  mxUnknown: "SignupMxUnknown",
  dispatchFailed: "SignupDispatchFailed",
} as const;

export type DispatchOutcome = { readonly outcome: "STALE" } | { readonly outcome: "DONE"; readonly branch: SignupBranch; readonly reason?: SignupRejectReason };

export type DispatchDeps = Pick<AccessDeps, "client" | "signups" | "cognito" | "keys" | "now" | "resolveMx">;

/** The context the seal of `signup.start` is bound to. */
export function sealContext(signupId: string): string {
  return `SIGNUP#${signupId}`;
}

/** Same hash for the counters of `signup.start` per domain (`rate` subkey). */
export function domainHash(rateKey: SecretKey, email: string): string {
  return hmacSha256Hex(rateKey, `domain|${domainOf(email)}`);
}

function rejected(log: Logger, reason: SignupRejectReason): void {
  countMetric(log, SIGNUP_METRICS.rejected, { reason });
}

async function findUsers(deps: DispatchDeps, email: string): Promise<FoundUser[]> {
  const users = await deps.cognito.findByEmail(email);
  return Promise.all(users.map(async (user: CognitoUser) => ({ user, groups: await deps.cognito.groupsOf(user.username) })));
}

/** Everything that suppresses before Cognito is asked anything about the email. */
async function suppressionOf(deps: DispatchDeps, signup: PendingSignup, log: Logger): Promise<SignupRejectReason | undefined> {
  const form = formSuppression(signup);
  if (form !== undefined) return form;
  const domain = domainSuppression(signup.email);
  if (domain !== undefined) return domain;
  const mx = await checkMx(domainOf(signup.email), deps.resolveMx);
  if (mx.status === "NO_MX") return "NO_MX";
  if (mx.status === "UNKNOWN") countMetric(log, SIGNUP_METRICS.mxUnknown);
  if ((await readMailStatus(deps.client, signup.emailHash)) !== undefined) return "MAIL_STATUS";
  if (await isBreakerOpen(deps.client)) return "BREAKER_OPEN";
  const quota = await gateEmail(deps.client, mailboxQuotaHash(deps.keys.leadEmail, signup.email), domainHash(deps.keys.rate, signup.email), deps.now());
  return quota === "OK" ? undefined : quota;
}

function metadataOf(signup: PendingSignup, intent?: string): Record<string, string> {
  return { lang: signup.language, ...(intent === undefined ? {} : { intent }) };
}

async function createUser(deps: DispatchDeps, signup: PendingSignup, password: string | undefined): Promise<"NEW" | "FAILED"> {
  if (password === undefined) return "FAILED";
  const validationData = issueTicket(deps.keys.ticket, { username: signup.username, emailHash: signup.emailHash, signupId: signup.signupId }, deps.now());
  await deps.cognito.signUp({ username: signup.username, email: signup.email, password, locale: signup.language, validationData: { ...validationData }, clientMetadata: metadataOf(signup) });
  return "NEW";
}

/** Acts on the classification; `password` is only in memory, already gone from the item. */
async function act(deps: DispatchDeps, signup: PendingSignup, found: Classification, password: string | undefined): Promise<{ branch: SignupBranch; accountUsername?: string }> {
  if (found.branch === "INELIGIBLE") return { branch: "INELIGIBLE" };
  if (found.branch === "EXISTING_GUEST") {
    await deps.cognito.forgotPassword(found.existing.user.username, metadataOf(signup, "signup-existing"));
    return { branch: "EXISTING_GUEST", accountUsername: found.existing.user.username };
  }
  if (found.replace !== undefined && !(await deps.cognito.deleteUnconfirmed(found.replace.user.username))) return { branch: "INELIGIBLE" };
  const branch = await createUser(deps, signup, password);
  return branch === "NEW" ? { branch, accountUsername: signup.username } : { branch };
}

async function start(deps: DispatchDeps, signup: PendingSignup, password: string | undefined, log: Logger): Promise<{ branch: SignupBranch; accountUsername?: string; reason?: SignupRejectReason }> {
  const suppressed = await suppressionOf(deps, signup, log);
  if (suppressed !== undefined) return { branch: "SUPPRESSED", reason: suppressed };
  const decided = await act(deps, signup, classifyExisting(await findUsers(deps, signup.email)), password);
  return decided.branch === "INELIGIBLE" ? { ...decided, reason: "INELIGIBLE" } : decided;
}

async function resend(deps: DispatchDeps, signup: PendingSignup, log: Logger): Promise<{ branch: SignupBranch; accountUsername?: string; reason?: SignupRejectReason }> {
  const kept = { branch: signup.branch ?? "FAILED", ...(signup.accountUsername === undefined ? {} : { accountUsername: signup.accountUsername }) } as const;
  if (kept.branch === "SUPPRESSED" || kept.branch === "INELIGIBLE") return kept;
  if ((await readMailStatus(deps.client, signup.emailHash)) !== undefined) return { ...kept, reason: "MAIL_STATUS" };
  if (await isBreakerOpen(deps.client)) return { ...kept, reason: "BREAKER_OPEN" };
  if (kept.branch === "NEW" && signup.accountUsername !== undefined) {
    await deps.cognito.resendCode(signup.accountUsername, metadataOf(signup));
    return kept;
  }
  if (kept.branch === "EXISTING_GUEST" && signup.accountUsername !== undefined) {
    await deps.cognito.forgotPassword(signup.accountUsername, metadataOf(signup, "signup-existing"));
    return kept;
  }
  // The first dispatch failed: classify again; without the password only an existing account's code can go out.
  const found = classifyExisting(await findUsers(deps, signup.email));
  if (found.branch === "EXISTING_GUEST") return act(deps, signup, found, undefined);
  const own = found.branch === "NEW" && found.replace?.user.username === signup.username;
  if (own) {
    await deps.cognito.resendCode(signup.username, metadataOf(signup));
    return { branch: "NEW", accountUsername: signup.username };
  }
  log.warn("signup.dispatch.resend_without_account", { signupId: signup.signupId });
  return { branch: "FAILED" };
}

/** One dispatch event; never throws for the visitor's data (a failure becomes `FAILED`). */
export async function runDispatch(deps: DispatchDeps, raw: unknown, log: Logger): Promise<DispatchOutcome> {
  const event = DispatchEvent.parse(raw);
  const claim = await deps.signups.claimDispatch(event.signupId, event.dispatchSeq, deps.now());
  if (claim === undefined) {
    log.info("signup.dispatch.stale", { signupId: event.signupId, dispatchSeq: event.dispatchSeq });
    return { outcome: "STALE" };
  }
  const { signup } = claim;
  let password: string | undefined;
  try {
    password = claim.sealed === undefined ? undefined : openSealed(deps.keys.seal, claim.sealed, sealContext(signup.signupId));
  } catch {
    password = undefined;
  }
  // No dispatch took its first step yet (the password is still sealed): this event is the sign-up's START.
  const neverDispatched = signup.dispatchedSeq === undefined || claim.sealed !== undefined;
  let decided: { branch: SignupBranch; accountUsername?: string; reason?: SignupRejectReason };
  try {
    decided = event.kind === "START" || neverDispatched ? await start(deps, signup, password, log) : await resend(deps, signup, log);
  } catch (error) {
    countMetric(log, SIGNUP_METRICS.dispatchFailed, { kind: event.kind, error: error instanceof Error ? error.name : "unknown" });
    decided = { branch: "FAILED" };
  } finally {
    password = undefined;
  }
  if (decided.reason !== undefined) rejected(log, decided.reason);
  await deps.signups.setBranch(signup.signupId, event.dispatchSeq, decided.branch, deps.now(), decided.accountUsername);
  log.info("signup.dispatch.done", { signupId: signup.signupId, kind: event.kind, branch: decided.branch });
  return { outcome: "DONE", branch: decided.branch, ...(decided.reason === undefined ? {} : { reason: decided.reason }) };
}
