// `finalizeSignup(signupId)` (ADR-0015 §1, §1.3 and §1.4): the only place a lead is born, idempotent,
// called by `signup.confirm` and by the hourly sweep. It runs only with the proof that the owner of the
// mailbox used the code, one of exactly two:
//
//   1  `SIGNUP#.verifiedAt` (written right after a successful ConfirmSignUp or ConfirmForgotPassword)
//   2  branch NEW and this sign-up's own `usr-<ulid>` is CONFIRMED, created after `startedAt`
//
// An EXISTING_GUEST sign-up without `verifiedAt` is never finalized: that the account exists and is
// confirmed proves nothing about who filled the form. Then: the lead (created or merged), the GUEST
// group only on a user with no group, the asynchronous notice of a new lead, and the sign-up deleted.
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

export async function finalizeSignup(deps: FinalizeDeps, signupId: string, log: Logger): Promise<FinalizeOutcome> {
  const signup = await deps.signups.get(signupId, deps.now());
  if (signup === undefined) return "GONE";
  if (!(await hasVerificationProof(deps, signup))) return "NO_PROOF";
  const now = deps.now();
  const username = signup.accountUsername ?? signup.username;
  const { lead, created } = await deps.leads.saveVerifiedLead(
    {
      newLeadId: deps.newUlid(),
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
      cognitoUsername: username,
    },
    now,
  );
  await deps.cognito.addGuestGroup(username);
  if (created) {
    try {
      await deps.invoker.invoke("LeadNotice", { leadKey: lead.emailHash });
    } catch (error) {
      // The lead stays PENDING and the hourly sweep sends the notice.
      log.warn("signup.finalize.notice_not_queued", { error: error instanceof Error ? error.name : "unknown" });
    }
  }
  await deps.signups.delete(signupId);
  countMetric(log, SIGNUP_METRICS.confirmed, { created });
  return "FINALIZED";
}
