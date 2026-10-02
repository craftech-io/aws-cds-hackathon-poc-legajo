// `GUEST_SWEEP` of `WorldJanitor`, the sign-up and lead part (ADR-0015 §5, FL-122), every hour on real
// time (the clock is injected):
//
//   1 Cognito users UNCONFIRMED and without groups for more than 24 h are deleted (fenced in
//     signup/cognito.ts: UNCONFIRMED and no group, read right before)
//   2 pending sign-ups with the proof of ADR-0015 §1.3 are finalized (never an EXISTING_GUEST without
//     `verifiedAt`); the rest expire by their 24-hour TTL
//   3 lead notices still PENDING are queued again (`LeadNotice` gives up after 5 attempts)
//   4 once a day, leads without a sign-in for 24 months (or since their sign-up) are deleted with
//     their account and their world, leaving `DELETED#<leadId>` with reason RETENTION
//
// The world part (public worlds past their TTL, stale `CREATING` leases, `GUEST_DESTROY`,
// `IDLE_GUEST_RESET`) belongs to the world factory (WP-31) and joins this sweep there.
import { LEAD_RETENTION_DAYS, UNCONFIRMED_USER_MAX_AGE_HOURS } from "@legajo/shared/guest-limits";
import type { Logger } from "../lib/log";
import { deleteLead } from "../leads/delete";
import type { AccessDeps } from "../signup/deps";
import { finalizeSignup, hasVerificationProof } from "../signup/finalize";

/** The daily part runs on the sweep of this UTC hour (03:00 in Buenos Aires). */
export const RETENTION_HOUR_UTC = 6;
/** A notice younger than this may still be on its way from `finalizeSignup`. */
export const NOTICE_RETRY_GRACE_MS = 10 * 60_000;

export type SweepDeps = Pick<AccessDeps, "client" | "signups" | "leads" | "cognito" | "invoker" | "keys" | "now" | "newUlid">;

export interface SweepReport {
  readonly unconfirmedDeleted: number;
  readonly finalized: number;
  readonly noticesQueued: number;
  readonly leadsRetired: number;
}

async function deleteStaleUnconfirmed(deps: SweepDeps, now: Date): Promise<number> {
  const cutoff = now.getTime() - UNCONFIRMED_USER_MAX_AGE_HOURS * 3_600_000;
  let deleted = 0;
  for (const user of await deps.cognito.listUnconfirmed()) {
    if (user.createdAt.getTime() < cutoff && (await deps.cognito.deleteUnconfirmed(user.username))) deleted += 1;
  }
  return deleted;
}

async function finalizeVerified(deps: SweepDeps, now: Date, log: Logger): Promise<number> {
  let finalized = 0;
  for (const signup of await deps.signups.listPending(now)) {
    if (!(await hasVerificationProof(deps, signup))) continue;
    if ((await finalizeSignup(deps, signup.signupId, log)) === "FINALIZED") finalized += 1;
  }
  return finalized;
}

async function retryNotices(deps: SweepDeps, now: Date): Promise<number> {
  let queued = 0;
  for (const lead of await deps.leads.listLeads()) {
    if (lead.noticeStatus !== "PENDING" || now.getTime() - Date.parse(lead.confirmedAt) < NOTICE_RETRY_GRACE_MS) continue;
    await deps.invoker.invoke("LeadNotice", { leadKey: lead.emailHash });
    queued += 1;
  }
  return queued;
}

async function retire(deps: SweepDeps, now: Date): Promise<number> {
  const cutoff = now.getTime() - LEAD_RETENTION_DAYS * 86_400_000;
  let retired = 0;
  for (const lead of await deps.leads.listLeads()) {
    if (Date.parse(lead.lastLoginAt ?? lead.signupAt) >= cutoff) continue;
    await deleteLead({ ...deps, leadEmailKey: deps.keys.leadEmail }, lead.email, "RETENTION");
    retired += 1;
  }
  return retired;
}

/** One hourly run; each part is independent, so a failure in one is logged and the others still run. */
export async function sweepSignupsAndLeads(deps: SweepDeps, log: Logger): Promise<SweepReport> {
  const now = deps.now();
  const part = async (name: string, run: () => Promise<number>): Promise<number> => {
    try {
      return await run();
    } catch (error) {
      log.error("guest_sweep.part_failed", { part: name, error: error instanceof Error ? error.name : "unknown" });
      return 0;
    }
  };
  const report: SweepReport = {
    unconfirmedDeleted: await part("unconfirmed", () => deleteStaleUnconfirmed(deps, now)),
    finalized: await part("finalize", () => finalizeVerified(deps, now, log)),
    noticesQueued: await part("notices", () => retryNotices(deps, now)),
    leadsRetired: now.getUTCHours() === RETENTION_HOUR_UTC ? await part("retention", () => retire(deps, now)) : 0,
  };
  log.info("guest_sweep.done", { ...report });
  return report;
}
