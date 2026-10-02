// The contact policy for one send (policy/engine.ts `evaluate`, docs/design-brief.md §5.7), with the
// quota of a guest world counted only when it can matter. `CP-WORLD-QUOTA` is the last rule: the first
// evaluation names the world but brings no verdict, so in a guest world it fails closed exactly when
// every other rule allowed the email. Only then is one unit of `OUTBOUND_EMAILS` consumed
// (policy/world-quota.ts over worlds/guest-quotas.ts) and the send decided again with that verdict: a
// denied or deferred email never spends quota, and a spent quota is a `DENY` audited like any other.
import { evaluate } from "../policy/engine";
import type { PolicyDecision, PolicyInput } from "../policy/types";
import { worldQuotaVerdict } from "../policy/world-quota";
import type { Logger } from "../lib/log";
import type { OutboundDeps } from "./deps";

export const WORLD_QUOTA_RULE = "CP-WORLD-QUOTA";

export async function decideSend(deps: Pick<OutboundDeps, "quotaTable" | "wallClock">, log: Logger, input: PolicyInput, clockId: string): Promise<PolicyDecision> {
  const first = evaluate({ ...input, worldQuota: { clockId } });
  if (first.outcome !== "DENY" || first.ruleIds[0] !== WORLD_QUOTA_RULE) return first;
  const verdict = await worldQuotaVerdict({ client: deps.quotaTable, now: deps.wallClock, log }, clockId);
  return evaluate({ ...input, worldQuota: verdict ?? { clockId } });
}

/** True when the send was denied by the guest world's quota (the caller answers `QUOTA_EXCEEDED`). */
export function deniedByQuota(decision: PolicyDecision): boolean {
  return decision.outcome === "DENY" && decision.ruleIds[0] === WORLD_QUOTA_RULE;
}
