// The lead of an account that just verified its phone (ADR-0021 §7 and §18): the only moment a lead of
// the public sign-up is born and noticed. The sign-up's draft (`DRAFT#<username>`, signup/finalize.ts)
// becomes the lead with the verified number, and `LeadNotice` is queued once, for a new lead only. An
// account whose lead already existed (born before the phone was asked for) only gets the number on it;
// an account with neither (staff, reserved guests) has no lead at all. Later sign-ins never come here.
import { leadEmailHash } from "../lib/crypto";
import type { Logger } from "../lib/log";
import { queueNotice } from "../signup/finalize";
import type { PhoneAccount, PhoneDeps } from "./service";

export async function enrolLead(deps: Pick<PhoneDeps, "leads" | "invoker" | "keys" | "now" | "newUlid">, account: Pick<PhoneAccount, "username" | "email">, phone: string, log: Logger): Promise<"CREATED" | "UPDATED" | "NONE"> {
  const now = deps.now();
  const at = now.toISOString();
  const draft = await deps.leads.getDraft(account.username, now);
  if (draft !== undefined) {
    const { expiresAt: _expiresAt, username, phone: _typed, ...fields } = draft;
    const { lead, created } = await deps.leads.saveVerifiedLead({ ...fields, newLeadId: deps.newUlid(), cognitoUsername: username, phone, phoneVerifiedAt: at }, now);
    if (created) await queueNotice(deps, lead.emailHash, log);
    await deps.leads.deleteDraft(account.username);
    return created ? "CREATED" : "UPDATED";
  }
  if (account.email === undefined) return "NONE";
  const emailHash = leadEmailHash(deps.keys.leadEmail, account.email);
  if ((await deps.leads.get(emailHash)) === undefined) return "NONE";
  await deps.leads.setPhone(emailHash, phone, at, now);
  return "UPDATED";
}
