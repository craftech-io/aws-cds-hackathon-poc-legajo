// Bounce state of the account emails and the reputation breaker (ADR-0015 §3.2,
// docs/architecture-integrations.md §8). Account emails (sign-up codes, recovery, invitations) and the
// lead notice leave through the app's configuration set but have no `Message` in `Conversations`, so
// `ChannelEvents` hands their permanent bounces and complaints here:
//
//   Runtime/MAILSTATUS#<emailHash>   {status BOUNCED | COMPLAINED, at, count}, lead or not (24 months)
//   Runtime/RL#MAILBAD#<hour>         bounces plus complaints of the hour
//   Runtime/MAILBREAKER               OPEN once the last 24 hours cross the threshold of guest-limits.ts
//
// `SignupDispatch` suppresses a recipient with a status, `AuthCustomMessage` refuses to mail it, and
// both stop (but for operator invitations) while the breaker is open. Only the operator closes it
// (`npm run signup:breaker -- --close`). This module never reads or writes `Leads`.
import { z } from "zod";
import { MAIL_BREAKER, MAIL_STATUS_TTL_SECONDS } from "@legajo/shared/guest-limits";
import type { Key, TableClient } from "../../connector/index";
import { type SecretKey, leadEmailHash } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import { RUNTIME_TABLE, countWindowed, counterKey } from "../../signup/counters";
import { countMetric } from "../adapter";

/** `RL#MAIL#TOTAL#<day>`: account emails sent (counted by `AuthCustomMessage`). */
export const MAIL_TOTAL_BASE = "RL#MAIL#TOTAL";
/** `RL#MAILBAD#<hour>`: permanent bounces and complaints of account emails. */
export const MAIL_BAD_BASE = "RL#MAILBAD";

export const MAIL_STATUS_METRICS = { breakerOpen: "AccountMailBreakerOpen", statusMarked: "AccountMailStatusMarked" } as const;

export const MailStatusValue = z.enum(["BOUNCED", "COMPLAINED"]);
export type MailStatusValue = z.infer<typeof MailStatusValue>;

export const MailStatus = z.object({ status: MailStatusValue, at: z.string(), count: z.number().int().min(1) });
export type MailStatus = z.infer<typeof MailStatus>;

export const MailBreaker = z.object({ state: z.enum(["OPEN", "CLOSED"]), openedAt: z.string().optional(), closedAt: z.string().optional(), reason: z.string().optional() });
export type MailBreaker = z.infer<typeof MailBreaker>;

export function mailStatusKey(emailHash: string): Key {
  return { PK: `MAILSTATUS#${emailHash}`, SK: "META" };
}

export const MAIL_BREAKER_KEY: Key = { PK: "MAILBREAKER", SK: "META" };

export async function readMailStatus(client: TableClient, emailHash: string): Promise<MailStatus | undefined> {
  const parsed = MailStatus.safeParse(await client.get(RUNTIME_TABLE, mailStatusKey(emailHash)));
  return parsed.success ? parsed.data : undefined;
}

/** `CLOSED` when the row is missing: the breaker starts closed. */
export async function readBreaker(client: TableClient): Promise<MailBreaker> {
  const parsed = MailBreaker.safeParse(await client.get(RUNTIME_TABLE, MAIL_BREAKER_KEY));
  return parsed.success ? parsed.data : { state: "CLOSED" };
}

export async function isBreakerOpen(client: TableClient): Promise<boolean> {
  return (await readBreaker(client)).state === "OPEN";
}

/** Bounces plus complaints, and account emails sent, over the last 24 hours. */
export async function mailHealth(client: TableClient, now: Date): Promise<{ readonly bad: number; readonly sent: number }> {
  const hours = Array.from({ length: MAIL_BREAKER.lookbackHours }, (_, index) => new Date(now.getTime() - index * 3_600_000));
  const badRows = await Promise.all(hours.map((at) => client.get(RUNTIME_TABLE, counterKey(MAIL_BAD_BASE, "HOUR", at))));
  const days = [now, new Date(now.getTime() - 86_400_000)];
  const sentRows = await Promise.all(days.map((at) => client.get(RUNTIME_TABLE, counterKey(MAIL_TOTAL_BASE, "DAY", at))));
  const sum = (rows: ReadonlyArray<Record<string, unknown> | undefined>) => rows.reduce((total, row) => total + (typeof row?.count === "number" ? row.count : 0), 0);
  return { bad: sum(badRows), sent: sum(sentRows) };
}

/** Whether the last 24 hours open the breaker, and why (never an address). */
export function breakerReason(health: { readonly bad: number; readonly sent: number }): string | undefined {
  if (health.bad >= MAIL_BREAKER.badCount) return `${health.bad} bounces or complaints in ${MAIL_BREAKER.lookbackHours} h`;
  if (health.sent >= MAIL_BREAKER.minSent && health.bad / health.sent > MAIL_BREAKER.badRate) return `bounce and complaint rate above ${MAIL_BREAKER.badRate * 100} %`;
  return undefined;
}

export interface MailStatusDeps {
  readonly client: TableClient;
  /** `lead-email` subkey: the same hash as `Leads/EMAIL#`, so `leads:export` can join it. */
  readonly leadEmailKey: SecretKey;
  readonly log: Logger;
  readonly now: () => Date;
}

/** A permanent bounce or a complaint of an account email (or of the lead notice), as `ChannelEvents` saw it. */
export const AccountMailEvent = z.object({ kind: z.enum(["BOUNCE", "COMPLAINT"]), recipients: z.array(z.string().min(3).max(320)).min(1).max(50) }).strict();
export type AccountMailEvent = z.infer<typeof AccountMailEvent>;

async function openBreaker(deps: MailStatusDeps, reason: string, now: Date): Promise<boolean> {
  if (await isBreakerOpen(deps.client)) return false;
  await deps.client.put(RUNTIME_TABLE, { ...MAIL_BREAKER_KEY, entity: "MailBreaker", state: "OPEN", openedAt: now.toISOString(), reason });
  countMetric(deps.log, MAIL_STATUS_METRICS.breakerOpen, { reason });
  return true;
}

/**
 * `markMailStatus`: records each recipient's status (a complaint is never downgraded to a bounce),
 * counts the event in the hour and opens the breaker when the last 24 hours cross the threshold.
 */
export async function markMailStatus(deps: MailStatusDeps, input: AccountMailEvent): Promise<{ readonly marked: number; readonly breakerOpened: boolean }> {
  const event = AccountMailEvent.parse(input);
  const now = deps.now();
  const status: MailStatusValue = event.kind === "COMPLAINT" ? "COMPLAINED" : "BOUNCED";
  let marked = 0;
  for (const recipient of new Set(event.recipients.map((address) => address.trim().toLowerCase()))) {
    let hash: string;
    try {
      hash = leadEmailHash(deps.leadEmailKey, recipient);
    } catch {
      continue;
    }
    const key = mailStatusKey(hash);
    const current = await readMailStatus(deps.client, hash);
    const kept = current?.status === "COMPLAINED" ? "COMPLAINED" : status;
    await deps.client.update(RUNTIME_TABLE, key, { set: { entity: "MailStatus", status: kept, at: now.toISOString(), expiresAt: Math.floor(now.getTime() / 1000) + MAIL_STATUS_TTL_SECONDS }, add: { count: 1 } }, now.toISOString(), { upsert: true });
    await countWindowed(deps.client, MAIL_BAD_BASE, "HOUR", now);
    marked += 1;
  }
  countMetric(deps.log, MAIL_STATUS_METRICS.statusMarked, { kind: event.kind, count: marked });
  const reason = breakerReason(await mailHealth(deps.client, now));
  const breakerOpened = reason === undefined ? false : await openBreaker(deps, reason, now);
  return { marked, breakerOpened };
}

/** The operator closes the breaker after reviewing the cause (`npm run signup:breaker -- --close`). */
export async function closeBreaker(client: TableClient, now: Date): Promise<MailBreaker> {
  const current = await readBreaker(client);
  if (current.state === "CLOSED") return current;
  const closed: MailBreaker = { state: "CLOSED", closedAt: now.toISOString() };
  await client.put(RUNTIME_TABLE, { ...MAIL_BREAKER_KEY, entity: "MailBreaker", ...closed });
  return closed;
}
