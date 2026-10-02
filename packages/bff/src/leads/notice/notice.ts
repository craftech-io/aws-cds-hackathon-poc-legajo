// `LeadNotice` (ADR-0015 §6, FL-115): one email to Craftech per confirmed sign-up, sent through the
// single SES client with the `LEAD_NOTICE` profile (no clock: no pending mail, no `Message`). The
// recipients come only from the `LeadNoticeTo` secret (up to 3, comma separated; `disabled` turns the
// notice off) and each must be `<local>@craftech.io` exactly; no destination is ever written in the
// code. State lives in the lead: `noticeStatus` SENT | PENDING (SES failed: the hourly sweep retries)
// | FAILED (5 attempts) | DISABLED (no valid recipient). The lead's email never reaches a log.
import { NOTICES_ADDRESS } from "@legajo/shared";
import { LEAD_NOTICE_MAX_ATTEMPTS, LEAD_NOTICE_MAX_RECIPIENTS } from "@legajo/shared/guest-limits";
import { z } from "zod";
import { countMetric } from "../../channels/adapter";
import { parseAddress } from "../../channels/email/address";
import { LEAD_NOTICE_DOMAIN } from "../../channels/email/fence";
import type { EmailClient } from "../../channels/email/outbound";
import type { Logger } from "../../lib/log";
import { EmailHash, type NoticeStatus } from "../lead";
import type { LeadStore } from "../store";
import { LEAD_NOTICE_FROM_NAME, LEAD_NOTICE_SUBJECT, leadNoticeBody } from "./body";

export const LeadNoticeEvent = z.object({ leadKey: EmailHash }).strict();
export type LeadNoticeEvent = z.infer<typeof LeadNoticeEvent>;

export const LEAD_NOTICE_METRICS = { failed: "LeadNoticeFailed" } as const;
export const DISABLED_VALUE = "disabled";

export type RecipientsVerdict = { readonly status: "OK"; readonly recipients: readonly string[] } | { readonly status: "DISABLED" } | { readonly status: "RECIPIENT_NOT_ALLOWED" };

/** The secret's value → the recipients, if every one is exactly `<local>@craftech.io` (strict parser). */
export function noticeRecipients(secret: string): RecipientsVerdict {
  const value = secret.trim();
  if (value === "" || value.toLowerCase() === DISABLED_VALUE) return { status: "DISABLED" };
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length > LEAD_NOTICE_MAX_RECIPIENTS || entries.some((entry) => entry === "")) return { status: "RECIPIENT_NOT_ALLOWED" };
  const recipients: string[] = [];
  for (const entry of entries) {
    const parsed = parseAddress(entry);
    if (!parsed.ok || parsed.value.domain !== LEAD_NOTICE_DOMAIN) return { status: "RECIPIENT_NOT_ALLOWED" };
    recipients.push(parsed.value.address);
  }
  return { status: "OK", recipients };
}

export interface LeadNoticeDeps {
  readonly leads: Pick<LeadStore, "get" | "setNotice">;
  readonly email: Pick<EmailClient, "send">;
  /** `LeadNoticeTo`, read when needed (lib: the linked secret). */
  readonly recipients: () => string;
  readonly now: () => Date;
  readonly log: Logger;
}

export type NoticeOutcome = NoticeStatus | "GONE" | "SKIPPED";

async function settle(deps: LeadNoticeDeps, leadKey: string, status: NoticeStatus, attempts: number, reason?: string): Promise<NoticeStatus> {
  await deps.leads.setNotice(leadKey, status, attempts, deps.now());
  if (reason !== undefined) countMetric(deps.log, LEAD_NOTICE_METRICS.failed, { reason, status });
  return status;
}

/** Sends the notice of one lead if it is still pending; idempotent for a lead already notified. */
export async function notifyLead(deps: LeadNoticeDeps, raw: unknown): Promise<NoticeOutcome> {
  const { leadKey } = LeadNoticeEvent.parse(raw);
  const lead = await deps.leads.get(leadKey);
  if (lead === undefined) return "GONE";
  if (lead.noticeStatus !== "PENDING") return "SKIPPED";
  const verdict = noticeRecipients(deps.recipients());
  if (verdict.status === "DISABLED") return settle(deps, leadKey, "DISABLED", lead.noticeAttempts);
  if (verdict.status === "RECIPIENT_NOT_ALLOWED") return settle(deps, leadKey, "DISABLED", lead.noticeAttempts, "RECIPIENT_NOT_ALLOWED");
  const attempts = lead.noticeAttempts + 1;
  const text = leadNoticeBody(lead);
  try {
    for (const to of verdict.recipients) {
      const result = await deps.email.send({ profile: "LEAD_NOTICE", from: { address: NOTICES_ADDRESS, displayName: LEAD_NOTICE_FROM_NAME }, to, subject: LEAD_NOTICE_SUBJECT, text, lang: "es", kind: "LEAD_NOTICE" });
      if (result.status === "REFUSED") return settle(deps, leadKey, "DISABLED", attempts, result.code);
    }
  } catch (error) {
    deps.log.warn("lead_notice.send_failed", { attempts, error: error instanceof Error ? error.name : "unknown" });
    return attempts >= LEAD_NOTICE_MAX_ATTEMPTS ? settle(deps, leadKey, "FAILED", attempts, "SES") : settle(deps, leadKey, "PENDING", attempts);
  }
  deps.log.info("lead_notice.sent", { recipients: verdict.recipients.length });
  return settle(deps, leadKey, "SENT", attempts);
}
