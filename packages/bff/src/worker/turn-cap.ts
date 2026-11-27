// What a turn may cost before the Harness is invoked (docs/architecture.md §7 and §13, ADR-0015 §4):
//
//   spend of a guest         the hold of worker/turn-cost.ts on `Runtime/COST#<sub>` of the person who holds
//                            the world (US$1 for the life of the account, no reset); past it, or in a guest
//                            world with no live owner, `TURN_COST` counts nothing, and the event closes with
//                            the note `TURN_COST`, the metric `GuestCostHits` and no outbound
//   quota of a guest world   every `GUEST#*` world counts its agent turns in real time with
//                            `consumeQuota(clockId, "AGENT_TURNS")` (worlds/guest-quotas.ts: 30 an hour,
//                            120 a day) and, in a public one, the daily budget of 1,500 turns of all public
//                            worlds; past either, `QUOTA_EXCEEDED` counts nothing, and the event closes with
//                            the note `TURN_QUOTA`, the metric `QuotaHits` or `GuestBudgetHits` and no outbound
//   turn cap of a firm       `TURNCAP#<firmId>#H<hour>` and `#D<day>` (real UTC) against
//                            `Firms/SETTINGS.turnCaps` (200/1,000 in a demo firm, 30/120 in a guest firm, its
//                            own budget for QA); past either, `TURN_CAP` is audited, `TurnCapHits` counted and
//                            the Harness is not invoked
//
// The spend goes first and the quota next: each refuses without counting, and a guest reads the honest
// `TURN_COST` or `TURN_QUOTA` (with its renewal time) instead of the firm's cap. A refusal after the
// hold gives the hold back. A refused turn is not retried: the cap or quota renews
// in real time and the next event of the operation gets its own turn.
import { QuotaExceededError } from "@legajo/shared/errors";
import type { QuotaExceededKind } from "@legajo/shared/guest-limits";
import type { Connector } from "../connector/index";
import type { Operation } from "../domain/operations";
import type { Logger } from "../lib/log";
import type { TurnCostHold, TurnCostLedger } from "./turn-cost";

export type TurnCapWindowKind = "HOUR" | "DAY";

export type TurnBudget =
  | { readonly allowed: true; readonly hold: TurnCostHold }
  | { readonly allowed: false; readonly refusal: "TURN_COST"; readonly reason: "EXHAUSTED" | "NO_OWNER" }
  | { readonly allowed: false; readonly refusal: "TURN_QUOTA"; readonly kind: QuotaExceededKind; readonly resetsAtReal: string }
  | { readonly allowed: false; readonly refusal: "TURN_CAP"; readonly window: TurnCapWindowKind; readonly count: number; readonly cap: number };

export interface TurnBudgetDeps {
  readonly data: Pick<Connector, "firms" | "runtime">;
  /** `consumeQuota(clockId, "AGENT_TURNS")` of worlds/guest-quotas.ts; a no-op outside `GUEST#*` worlds. */
  readonly consumeTurnQuota: (clockId: string, log: Logger) => Promise<void>;
  /** The spend cap of the person who holds a guest world (worker/turn-cost.ts). */
  readonly turnCost: TurnCostLedger;
  /** Real time: caps and quotas run on the wall clock, never on the world's simulated one. */
  readonly now: () => Date;
  /** Where `QuotaHits` and `GuestBudgetHits` are logged. */
  readonly log: Logger;
}

/** `H<yyyy-mm-ddThh>` and `D<yyyy-mm-dd>` (UTC) of a real instant: the windows of `TURNCAP#`. */
export function turnCapWindows(at: Date): { readonly hour: string; readonly day: string } {
  const iso = at.toISOString();
  return { hour: `H${iso.slice(0, 13)}`, day: `D${iso.slice(0, 10)}` };
}

/** Holds the turn's spend and counts it in its world's quota and its firm's caps; the first limit passed refuses it. */
export async function checkTurnBudget(deps: TurnBudgetDeps, operation: Pick<Operation, "firmId" | "clockId">): Promise<TurnBudget> {
  const cost = await deps.turnCost.hold(operation, deps.log);
  if (!cost.allowed) return { allowed: false, refusal: "TURN_COST", reason: cost.reason };
  try {
    const refusal = await countTurn(deps, operation);
    if (refusal !== undefined) await cost.hold.release();
    return refusal ?? { allowed: true, hold: cost.hold };
  } catch (error) {
    await cost.hold.release();
    throw error;
  }
}

async function countTurn(deps: TurnBudgetDeps, operation: Pick<Operation, "firmId" | "clockId">): Promise<Exclude<TurnBudget, { allowed: true }> | undefined> {
  try {
    await deps.consumeTurnQuota(operation.clockId, deps.log);
  } catch (error) {
    if (error instanceof QuotaExceededError) return { allowed: false, refusal: "TURN_QUOTA", kind: error.kind, resetsAtReal: error.resetsAtReal };
    throw error;
  }
  const settings = await deps.data.firms.getSettings(operation.firmId);
  const windows = turnCapWindows(deps.now());
  const hour = await deps.data.runtime.incrementTurnCap({ firmId: operation.firmId, window: windows.hour });
  if (hour > settings.turnCaps.perHour) return { allowed: false, refusal: "TURN_CAP", window: "HOUR", count: hour, cap: settings.turnCaps.perHour };
  const day = await deps.data.runtime.incrementTurnCap({ firmId: operation.firmId, window: windows.day });
  if (day > settings.turnCaps.perDay) return { allowed: false, refusal: "TURN_CAP", window: "DAY", count: day, cap: settings.turnCaps.perDay };
  return undefined;
}
