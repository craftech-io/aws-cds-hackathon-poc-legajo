// Deleting a lead and its account (ADR-0015 §6, FL-118, FL-122): one module for `npm run leads:delete`,
// the retention of `GUEST_SWEEP` and the `QaDriver`'s `lead.purge` of SC-26. In order:
//
//   1 the account's world: a leased one is destroyed by `WorldJanitor` (`GUEST_DESTROY {firmId,
//     reason, sub}`, with every S3 object of the world; it releases the slot by `SLOT#GUEST#<nn>`),
//     and the account's lease `GUESTWORLD#<sub>` is deleted here either way
//   2 every Cognito user of the email (`AdminDeleteUser`)
//   3 the lead, the pending sign-ups of the email, `MAILSTATUS#` and the counters of its mailbox
//   4 `DELETED#<leadId>` with when and why, without any personal data
//
// It returns only the `leadId`; the email never leaves the caller.
import type { TableClient } from "../connector/index";
import { type SecretKey, leadEmailHash, mailboxQuotaHash } from "../lib/crypto";
import { MAIL_BASES } from "../auth-triggers/custom-message";
import { RUNTIME_TABLE, forgetWindowed } from "../signup/counters";
import { mailStatusKey } from "../channels/email/mail-status";
import type { SignupCognito } from "../signup/cognito";
import type { AsyncInvoker } from "../signup/invoke";
import { forgetEmailCounters } from "../signup/rate-limits";
import type { SignupStore } from "../signup/store";
import { accountWorldKey, readAccountWorld } from "../worlds/guest-slots";
import type { LeadStore } from "./store";

export interface LeadDeleteDeps {
  readonly client: TableClient;
  readonly leads: Pick<LeadStore, "get" | "delete" | "putTombstone">;
  readonly signups: Pick<SignupStore, "listPending" | "delete">;
  readonly cognito: Pick<SignupCognito, "findByEmail" | "deleteUser">;
  readonly invoker: AsyncInvoker;
  readonly leadEmailKey: SecretKey;
  readonly now: () => Date;
}

export interface LeadDeletion {
  /** The deleted lead's id; `undefined` when the email had no lead (its account and traces go anyway). */
  readonly leadId?: string;
  readonly users: number;
  /** Worlds handed to `WorldJanitor` for destruction. */
  readonly worldsDestroyed: number;
}

/** Deletes everything of `email` (normalized by the caller's parser); idempotent. */
export async function deleteLead(deps: LeadDeleteDeps, email: string, reason: "REQUEST" | "RETENTION"): Promise<LeadDeletion> {
  const now = deps.now();
  const emailHash = leadEmailHash(deps.leadEmailKey, email);
  const lead = await deps.leads.get(emailHash);
  const users = await deps.cognito.findByEmail(email);
  let worldsDestroyed = 0;
  for (const user of users) {
    if (user.sub !== undefined) {
      const lease = await readAccountWorld(deps.client, user.sub);
      const leasedWorld = lease !== undefined && lease.firmId !== undefined && (lease.state === "READY" || lease.state === "CREATING");
      if (leasedWorld) {
        await deps.invoker.invoke("WorldJanitor", { kind: "GUEST_DESTROY", firmId: lease.firmId, reason, sub: user.sub });
        worldsDestroyed += 1;
      }
      if (lease !== undefined) await deps.client.delete(RUNTIME_TABLE, accountWorldKey(user.sub));
    }
    await deps.cognito.deleteUser(user.username);
  }
  for (const signup of await deps.signups.listPending(now)) if (signup.emailHash === emailHash) await deps.signups.delete(signup.signupId);
  await deps.client.delete(RUNTIME_TABLE, mailStatusKey(emailHash));
  const mailboxHash = mailboxQuotaHash(deps.leadEmailKey, email);
  await forgetEmailCounters(deps.client, mailboxHash, now);
  await forgetWindowed(deps.client, MAIL_BASES.recipient(mailboxHash), ["DAY"], now);
  if (lead === undefined) return { users: users.length, worldsDestroyed };
  await deps.leads.delete(emailHash);
  await deps.leads.putTombstone({ leadId: lead.leadId, deletedAt: now.toISOString(), reason }, now);
  return { leadId: lead.leadId, users: users.length, worldsDestroyed };
}
