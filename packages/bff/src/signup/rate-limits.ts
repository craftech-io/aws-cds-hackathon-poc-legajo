// Rate limits and capacity of the sign-up (ADR-0015 §3.2), with the numbers of guest-limits.ts. The
// BFF keeps those that may answer before anything is known about the email (per viewer IP →
// `RATE_LIMITED`, new sign-ups in total → `CAPACITY`); `SignupDispatch` keeps those that would tell
// something about the email (per mailbox, per domain → `SUPPRESSED`, the same `CODE_SENT`). IP, mailbox
// and domain are keyed hashes: `rate` subkey for the IP and the domain, `lead-email` for the canonical
// mailbox (`mailboxQuotaHash`: `+tag` and Gmail dot variants share it; the key `leads:delete` forgets).
import { SIGNUP_RATE_LIMITS } from "@legajo/shared/guest-limits";
import type { TableClient } from "../connector/index";
import { type CounterOutcome, consumeWindowed, forgetWindowed } from "./counters";

export const RATE_BASES = {
  startIp: (ipHash: string) => `RL#START#IP#${ipHash}`,
  startTotal: "RL#START#TOTAL",
  startEmail: (mailboxHash: string) => `RL#START#EMAIL#${mailboxHash}`,
  startDomain: (domainHash: string) => `RL#START#DOMAIN#${domainHash}`,
  confirmIp: (ipHash: string) => `RL#CONFIRM#IP#${ipHash}`,
} as const;

export type StartGate = { readonly status: "OK" } | { readonly status: "RATE_LIMITED"; readonly retryAfterSec: number } | { readonly status: "CAPACITY" };

function retryAfter(outcome: Extract<CounterOutcome, { ok: false }>, now: Date): number {
  return Math.max(1, Math.ceil((outcome.resetsAt.getTime() - now.getTime()) / 1000));
}

/** `signup.start` per viewer IP (`RATE_LIMITED`), then the new sign-ups of the whole demo (`CAPACITY`). */
export async function gateStart(client: TableClient, ipHash: string, now: Date): Promise<StartGate> {
  const perIp = await consumeWindowed(client, [{ base: RATE_BASES.startIp(ipHash), limits: SIGNUP_RATE_LIMITS.startPerIp }], now);
  if (!perIp.ok) return { status: "RATE_LIMITED", retryAfterSec: retryAfter(perIp, now) };
  const total = await consumeWindowed(client, [{ base: RATE_BASES.startTotal, limits: SIGNUP_RATE_LIMITS.startTotal }], now);
  return total.ok ? { status: "OK" } : { status: "CAPACITY" };
}

/** `signup.confirm` per viewer IP. */
export async function gateConfirm(client: TableClient, ipHash: string, now: Date): Promise<{ readonly ok: true } | { readonly ok: false; readonly retryAfterSec: number }> {
  const outcome = await consumeWindowed(client, [{ base: RATE_BASES.confirmIp(ipHash), limits: SIGNUP_RATE_LIMITS.confirmPerIp }], now);
  return outcome.ok ? { ok: true } : { ok: false, retryAfterSec: retryAfter(outcome, now) };
}

/** Sign-ups of one mailbox (`mailboxQuotaHash`) and of one domain (decided by `SignupDispatch`, after the answer). */
export async function gateEmail(client: TableClient, mailboxHash: string, domainHash: string, now: Date): Promise<"OK" | "EMAIL_QUOTA" | "DOMAIN_QUOTA"> {
  const email = await consumeWindowed(client, [{ base: RATE_BASES.startEmail(mailboxHash), limits: SIGNUP_RATE_LIMITS.startPerEmail }], now, { explain: false });
  if (!email.ok) return "EMAIL_QUOTA";
  const domain = await consumeWindowed(client, [{ base: RATE_BASES.startDomain(domainHash), limits: SIGNUP_RATE_LIMITS.startPerDomain }], now, { explain: false });
  return domain.ok ? "OK" : "DOMAIN_QUOTA";
}

/** `leads:delete`: the counters keyed by that email's mailbox (`mailboxQuotaHash`). */
export async function forgetEmailCounters(client: TableClient, mailboxHash: string, now: Date): Promise<void> {
  await forgetWindowed(client, RATE_BASES.startEmail(mailboxHash), SIGNUP_RATE_LIMITS.startPerEmail.map((limit) => limit.window), now);
}
