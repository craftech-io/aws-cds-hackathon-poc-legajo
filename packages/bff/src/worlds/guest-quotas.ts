// Usage quotas of the guest worlds in real time (ADR-0015 §4), with the numbers of guest-limits.ts:
// `consumeQuota(clockId, kind)` counts one unit in every window of the kind (and, in a public world,
// in the daily global budget of the turns and emails of all public worlds), or refuses with
// `QUOTA_EXCEEDED {kind, resetsAtReal}` and counts nothing. Counters: `Runtime/QUOTA#<clockId>#<kind>#<window>`,
// `Runtime/QUOTA#GUEST_PUBLIC#<kind>#<UTC day>` and, for `account.ensureWorld`, `QUOTA#ACCOUNT#<sub>#…`.
// Callers: the worker (turns), the outbound pipeline (emails, rule `CP-WORLD-QUOTA`), the console's
// procedures (clock moves, simulator, uploads, operations, resets, live clock) and `ensureWorld`.
// Worlds that are not `GUEST#*` have no quota.
import { parseClockId } from "@legajo/shared";
import { QuotaExceededError } from "@legajo/shared/errors";
import { GUEST_QUOTAS, PUBLIC_GLOBAL_BUDGET, type QuotaKind, type WindowedLimit } from "@legajo/shared/guest-limits";
import type { QuotaUsage } from "@legajo/shared/signup";
import { countMetric } from "../channels/adapter";
import type { TableClient } from "../connector/index";
import type { Logger } from "../lib/log";
import { type CounterGroup, consumeWindowed, fullestWindow, readWindowed } from "../signup/counters";
import { isPublicGuestFirm } from "./guest-slots";

export const QUOTA_METRICS = { hits: "QuotaHits", budget: "GuestBudgetHits" } as const;

export interface QuotaDeps {
  readonly client: TableClient;
  /** Real time: quotas run on the wall clock, never on the world's simulated clock. */
  readonly now: () => Date;
  readonly log: Logger;
}

/** The firm of a guest world's clock, or `undefined` for every other world (no quota). */
export function guestFirmOfClock(clockId: string): string | undefined {
  const parsed = parseClockId(clockId);
  return parsed?.scope === "GUEST" ? parsed.firmId : undefined;
}

function globalGroup(kind: QuotaKind): CounterGroup | undefined {
  const limit = PUBLIC_GLOBAL_BUDGET[kind];
  return limit === undefined ? undefined : { base: `QUOTA#GUEST_PUBLIC#${kind}`, limits: [{ window: "DAY", limit }] };
}

function worldGroup(clockId: string, kind: QuotaKind): CounterGroup {
  return { base: `QUOTA#${clockId}#${kind}`, limits: GUEST_QUOTAS[kind] };
}

async function consumeGroups(deps: QuotaDeps, groups: readonly CounterGroup[], kind: QuotaKind, budget: CounterGroup | undefined): Promise<void> {
  const now = deps.now();
  const outcome = await consumeWindowed(deps.client, budget === undefined ? groups : [...groups, budget], now);
  if (outcome.ok) return;
  if (budget !== undefined) {
    const spent = fullestWindow(await readWindowed(deps.client, budget.base, budget.limits, now));
    if (!spent.ok) {
      countMetric(deps.log, QUOTA_METRICS.budget, { kind });
      throw new QuotaExceededError("GLOBAL", spent.resetsAt.toISOString());
    }
  }
  const own = fullestWindow((await Promise.all(groups.map((group) => readWindowed(deps.client, group.base, group.limits, now)))).flat());
  countMetric(deps.log, QUOTA_METRICS.hits, { kind });
  throw new QuotaExceededError(kind, (own.ok ? outcome.resetsAt : own.resetsAt).toISOString());
}

/** One unit of `kind` in the world of `clockId`; throws `QuotaExceededError` and counts nothing past a limit. */
export async function consumeQuota(deps: QuotaDeps, clockId: string, kind: Exclude<QuotaKind, "WORLD_PREPARATIONS">): Promise<void> {
  const firmId = guestFirmOfClock(clockId);
  if (firmId === undefined) return;
  await consumeGroups(deps, [worldGroup(clockId, kind)], kind, isPublicGuestFirm(firmId) ? globalGroup(kind) : undefined);
}

/** One `account.ensureWorld` call of an account (10 an hour): counted by `sub`, the world may not exist yet. */
export async function consumeWorldPreparation(deps: QuotaDeps, sub: string): Promise<void> {
  await consumeGroups(deps, [{ base: `QUOTA#ACCOUNT#${sub}#WORLD_PREPARATIONS`, limits: GUEST_QUOTAS.WORLD_PREPARATIONS }], "WORLD_PREPARATIONS", undefined);
}

function usageOf(kind: QuotaKind, readings: ReadonlyArray<{ window: WindowedLimit["window"]; used: number; limit: number; resetsAt: Date }>): QuotaUsage[] {
  return readings.map((reading) => ({ kind, window: reading.window, used: reading.used, limit: reading.limit, resetsAtReal: reading.resetsAt.toISOString() }));
}

export interface UsageReport {
  readonly quotas: QuotaUsage[];
  readonly globalBudget: "OK" | "EXHAUSTED";
}

/** `account.usage`: every window of every kind of the world (and the account's preparations), plus the global budget. */
export async function readUsage(client: TableClient, input: { readonly clockId?: string; readonly sub: string }, now: Date): Promise<UsageReport> {
  const quotas: QuotaUsage[] = [];
  const firmId = input.clockId === undefined ? undefined : guestFirmOfClock(input.clockId);
  for (const kind of Object.keys(GUEST_QUOTAS) as QuotaKind[]) {
    const base = kind === "WORLD_PREPARATIONS" ? `QUOTA#ACCOUNT#${input.sub}#${kind}` : input.clockId === undefined || firmId === undefined ? undefined : `QUOTA#${input.clockId}#${kind}`;
    if (base !== undefined) quotas.push(...usageOf(kind, await readWindowed(client, base, GUEST_QUOTAS[kind], now)));
  }
  let exhausted = false;
  if (firmId !== undefined && isPublicGuestFirm(firmId)) {
    for (const kind of Object.keys(PUBLIC_GLOBAL_BUDGET) as QuotaKind[]) {
      const group = globalGroup(kind);
      if (group !== undefined && !fullestWindow(await readWindowed(client, group.base, group.limits, now)).ok) exhausted = true;
    }
  }
  return { quotas, globalBudget: exhausted ? "EXHAUSTED" : "OK" };
}

