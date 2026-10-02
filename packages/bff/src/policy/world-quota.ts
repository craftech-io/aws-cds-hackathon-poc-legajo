// `CP-WORLD-QUOTA` (ADR-0015 §4, FL-111): an email of a guest world (`GUEST#*`) goes out only inside
// its world's quota of outgoing emails (and, in a public world, the daily budget of every public world).
// The engine is pure, so the count happens before it: the outbound pipeline asks `worldQuotaVerdict`,
// which consumes one unit of `OUTBOUND_EMAILS` (worlds/guest-quotas.ts), and hands the verdict to the
// engine in `PolicyInput.worldQuota`; the rule turns it into the decision, audited like any other
// denial. Other worlds have no quota. A past send re-checked (`PolicyAudit`) skips the rule: the
// counters of that moment are gone, and its ALLOW already recorded the verdict.
import { QuotaExceededError } from "@legajo/shared/errors";
import { deny, missing, pass, skip } from "./checks";
import type { PolicyContext } from "./context";
import type { RuleCheck } from "./types";
import { type QuotaDeps, consumeQuota, guestFirmOfClock } from "../worlds/guest-quotas";

/** What the pipeline hands the engine for an email of a world. */
export interface WorldQuotaVerdict {
  readonly clockId: string;
  readonly allowed: boolean;
  readonly detail?: string;
}

export const WORLD_QUOTA_SKIP_PAST = "world quotas are counted when a send is decided, never for a past one";

/**
 * Counts the email in its world's quota; `undefined` for a world without quotas (anything not
 * `GUEST#*`). Throws only for a store that cannot be reached (the send fails closed upstream).
 */
export async function worldQuotaVerdict(deps: QuotaDeps, clockId: string): Promise<WorldQuotaVerdict | undefined> {
  if (guestFirmOfClock(clockId) === undefined) return undefined;
  try {
    await consumeQuota(deps, clockId, "OUTBOUND_EMAILS");
    return { clockId, allowed: true, detail: "inside the guest world's quota of outgoing emails" };
  } catch (error) {
    if (!(error instanceof QuotaExceededError)) throw error;
    const what = error.kind === "GLOBAL" ? "the daily budget of the public guest worlds" : "the guest world's quota of outgoing emails";
    return { clockId, allowed: false, detail: `${what} is spent until ${error.resetsAtReal}` };
  }
}

/**
 * The rule: the pipeline names the world of every email it decides (`worldQuota.clockId`); an email of
 * a guest world without a counted verdict fails closed, any other world has no quota.
 */
export function checkWorldQuota(ctx: PolicyContext): RuleCheck {
  if (ctx.mode !== "SEND") return skip(WORLD_QUOTA_SKIP_PAST);
  if (ctx.message.channel !== "EMAIL") return skip("only the emails of a guest world are counted");
  const verdict = ctx.input.worldQuota;
  if (verdict === undefined || guestFirmOfClock(verdict.clockId) === undefined) return skip("not a guest world: no quota of outgoing emails");
  if (verdict.allowed === undefined) return missing(ctx, "the guest world's quota verdict");
  return verdict.allowed ? pass(verdict.detail ?? "inside the guest world's quota") : deny(verdict.detail ?? "the guest world's quota of outgoing emails is spent");
}
