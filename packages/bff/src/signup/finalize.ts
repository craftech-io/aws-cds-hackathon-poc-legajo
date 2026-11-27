// `finalizeSignup(signupId)` (ADR-0015 §1, §1.3 and §1.4): the only place a lead is born, idempotent,
// called by `signup.confirm` and by the hourly sweep. It runs only with the proof that the owner of the
// mailbox used the code, one of exactly two:
//
//   1  `SIGNUP#.verifiedAt` (written right after a successful ConfirmSignUp or ConfirmForgotPassword)
//   2  branch NEW and this sign-up's own `usr-<ulid>` is CONFIRMED, created after `startedAt`
//
// An EXISTING_GUEST sign-up without `verifiedAt` is never finalized: that the account exists and is
// confirmed proves nothing about who filled the form. Then: an existing lead of the email merges the new
// sign-up; otherwise the lead waits as a draft (`DRAFT#<username>`) until the account verifies its phone
// by SMS, which is where it is born and noticed (ADR-0021, phone-verification/enrol.ts); the GUEST group
// only on a user with no group, and the sign-up deleted.
import { countMetric } from "../channels/adapter";
import type { Logger } from "../lib/log";
import type { PendingSignup } from "../leads/lead";
import type { AccessDeps } from "./deps";
import { SIGNUP_METRICS } from "./dispatch";

export type FinalizeDeps = Pick<AccessDeps, "signups" | "leads" | "cognito" | "invoker" | "now" | "newUlid">;

export type FinalizeOutcome = "FINALIZED" | "NO_PROOF" | "GONE";

/** Proof of §1.3; reads Cognito only for the second form. */
export async function hasVerificationProof(deps: Pick<FinalizeDeps, "cognito">, signup: PendingSignup): Promise<boolean> {
  if (signup.verifiedAt !== undefined) return true;
  if (signup.branch !== "NEW") return false;
  const own = await deps.cognito.getUser(signup.username);
  return own?.status === "CONFIRMED" && own.createdAt.getTime() > Date.parse(signup.startedAt);
}

/** The asynchronous notice of a new lead; a lead left PENDING is noticed by the hourly sweep. */
export async function queueNotice(deps: Pick<FinalizeDeps, "invoker">, leadKey: string, log: Logger): Promise<void> {
  try {
    await deps.invoker.invoke("LeadNotice", { leadKey });
  } catch (error) {
    log.warn("signup.finalize.notice_not_queued", { error: error instanceof Error ? error.name : "unknown" });
  }
}

export async function finalizeSignup(deps: FinalizeDeps, signupId: string, log: Logger): Promise<FinalizeOutcome> {
  const signup = await deps.signups.get(signupId, deps.now());
  if (signup === undefined) return "GONE";
  if (!(await hasVerificationProof(deps, signup))) return "NO_PROOF";
  const now = deps.now();
  const username = signup.accountUsername ?? signup.username;
  const fields = {
    email: signup.email,
    emailHash: signup.emailHash,
    ...(signup.name === undefined ? {} : { name: signup.name }),
    ...(signup.company === undefined ? {} : { company: signup.company }),
    ...(signup.jobTitle === undefined ? {} : { jobTitle: signup.jobTitle }),
    consents: signup.consents,
    language: signup.language,
    utm: signup.utm,
    ...(signup.referrer === undefined ? {} : { referrer: signup.referrer }),
    signupAt: signup.startedAt,
    confirmedAt: signup.verifiedAt ?? now.toISOString(),
  };
  const existing = await deps.leads.get(signup.emailHash);
  let created = false;
  if (existing === undefined) {
    await deps.leads.saveDraft({ ...fields, username, ...(signup.phone === undefined ? {} : { phone: signup.phone }) }, now);
  } else {
    const saved = await deps.leads.saveVerifiedLead({ ...fields, newLeadId: deps.newUlid(), cognitoUsername: username }, now);
    created = saved.created;
    if (created) await queueNotice(deps, saved.lead.emailHash, log);
  }
  await deps.cognito.addGuestGroup(username);
  await deps.signups.delete(signupId);
  countMetric(log, SIGNUP_METRICS.confirmed, { created, draft: existing === undefined });
  return "FINALIZED";
}
