// The SMS limits of SMS_LIMITS (packages/shared/src/guest-limits.ts) on the windowed counters of
// `Runtime` (signup/counters.ts, the same mechanism as the sign-up and the account emails): one unit in
// every window of the account, the number, the viewer IP and the whole demo (and, for a number outside
// the home region, the foreign quota of the whole demo), or in none. A refusal names the limit that is
// full, so the screen can say which one and when it resets.
import { SMS_LIMITS, type SmsLimit } from "@legajo/shared/guest-limits";
import type { TableClient } from "../connector/index";
import { type CounterGroup, consumeWindowed, fullestWindow, readWindowed } from "../signup/counters";

export interface SmsCapKeys {
  readonly sub: string;
  readonly phoneHash: string;
  /** HMAC of the viewer's aggregated IP; absent only for calls built on the server. */
  readonly ipHash?: string;
  /** A number of the home region (phone-policy.ts): it never counts in the foreign quota. */
  readonly home: boolean;
}

export type SmsCapOutcome = { readonly ok: true } | { readonly ok: false; readonly limit: SmsLimit; readonly retryAfterSec: number };

function groupsOf(keys: SmsCapKeys): Array<CounterGroup & { readonly name: SmsLimit }> {
  return [
    { name: "perAccount", base: `RL#SMS#ACCOUNT#${keys.sub}`, limits: SMS_LIMITS.perAccount },
    { name: "perNumber", base: `RL#SMS#NUMBER#${keys.phoneHash}`, limits: SMS_LIMITS.perNumber },
    ...(keys.ipHash === undefined ? [] : [{ name: "perIp" as const, base: `RL#SMS#IP#${keys.ipHash}`, limits: SMS_LIMITS.perIp }]),
    { name: "total", base: "RL#SMS#TOTAL", limits: SMS_LIMITS.total },
    ...(keys.home ? [] : [{ name: "foreign" as const, base: "RL#SMS#FOREIGN", limits: SMS_LIMITS.foreign }]),
  ];
}

/** Counts one SMS in every limit, or refuses with the first full one. */
export async function consumeSms(client: TableClient, keys: SmsCapKeys, now: Date): Promise<SmsCapOutcome> {
  const groups = groupsOf(keys);
  const outcome = await consumeWindowed(client, groups, now, { explain: false });
  if (outcome.ok) return outcome;
  for (const group of groups) {
    const full = fullestWindow(await readWindowed(client, group.base, group.limits, now));
    if (!full.ok) return { ok: false, limit: group.name, retryAfterSec: Math.max(1, Math.ceil((full.resetsAt.getTime() - now.getTime()) / 1000)) };
  }
  // A race on the very last unit can leave every reading just under its limit: still a refusal.
  return { ok: false, limit: "total", retryAfterSec: Math.max(1, Math.ceil((outcome.resetsAt.getTime() - now.getTime()) / 1000)) };
}
