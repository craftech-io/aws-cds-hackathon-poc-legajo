// Spend cap of a registered guest (ADR-0015 §4): every turn of a guest world is charged to the person
// who holds that world, never to the world, so a slot that goes to someone else starts nobody at zero
// and a person who gets a new world keeps what they spent.
//
//   owner     the `sub` bound to the world's broker row `Firms/BROKER#brk-guest-<nn>` (the binding the
//             pre-token stamps into the tokens), checked against the slot's lease `SLOT#GUEST#<nn>`
//             (same `sub`, not released); worlds that are not `GUEST#*`, and `guest-test` (our QA
//             account), are internal and have no cap; a guest world without a live owner gets no turn
//   ledger    `Runtime/COST#<sub>` / `META`, no TTL: `committedMicros` (spent plus the holds of the turns
//             in flight) and `spentMicros`, in micro-dollars
//   hold      before the Harness, `ADD committedMicros <hold>` on condition `committedMicros <= cap - hold`:
//             of two concurrent turns at the edge only the one that fits opens; the other is `TURN_COST`
//   close     usage reported: `ADD committedMicros <cost - hold>`, `spentMicros <cost>` (tokens × the
//             rates of services/ratecard.ts plus the overhead of the calls the usage does not report);
//             the model ran with no usage (timeout, stream error): the hold stays as the turn's cost;
//             the model never ran (a refusal after the hold, a G1 block, a throttle): the hold goes back
import { ConnectorError, parseClockId } from "@legajo/shared";
import { GUEST_AGENT_COST_CAP_USD, TURN_COST_HOLD_USD } from "@legajo/shared/guest-limits";
import type { TableClient } from "../connector/index";
import { brokerKey } from "../connector/keys";
import type { Key } from "../connector/table-client";
import type { Operation } from "../domain/operations";
import type { Logger } from "../lib/log";
import { type TurnTokens, guestTurnCostMicros } from "../services/ratecard";
import { RUNTIME_TABLE } from "../signup/counters";
import { readSlot } from "../worlds/guest-slots";
import { GUEST_TEST_FIRM, guestIdentity } from "../worlds/world-ids";

const MICROS = 1_000_000;
export const COST_CAP_MICROS = Math.round(GUEST_AGENT_COST_CAP_USD * MICROS);
export const COST_HOLD_MICROS = Math.round(TURN_COST_HOLD_USD * MICROS);
const ENTITY = "GuestAgentCost";

export const TURN_COST_METRIC = "GuestCostHits";

export function costKey(sub: string): Key {
  return { PK: `COST#${sub}`, SK: "META" };
}

export type CostOwner = { readonly kind: "INTERNAL" } | { readonly kind: "GUEST"; readonly sub: string } | { readonly kind: "ORPHAN" };

/** Who pays the turns of the operation's world (see the header). */
export async function costOwnerOf(client: TableClient, operation: Pick<Operation, "firmId" | "clockId">): Promise<CostOwner> {
  if (parseClockId(operation.clockId)?.scope !== "GUEST" || operation.firmId === GUEST_TEST_FIRM) return { kind: "INTERNAL" };
  let identity: ReturnType<typeof guestIdentity>;
  try {
    identity = guestIdentity(operation.firmId);
  } catch {
    return { kind: "ORPHAN" };
  }
  const broker = await client.get("Firms", brokerKey(operation.firmId, identity.brokerId));
  const sub = broker?.active === true && typeof broker.cognitoSub === "string" && broker.cognitoSub !== "" ? broker.cognitoSub : undefined;
  if (sub === undefined) return { kind: "ORPHAN" };
  if (identity.nn !== undefined) {
    const slot = await readSlot(client, identity.nn);
    if (slot !== undefined && (slot.releasedAtReal !== undefined || slot.sub !== sub || slot.firmId !== operation.firmId)) return { kind: "ORPHAN" };
  }
  return { kind: "GUEST", sub };
}

export interface GuestCost {
  readonly spentMicros: number;
  readonly committedMicros: number;
}

function micros(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function readGuestCost(client: TableClient, sub: string): Promise<GuestCost> {
  const row = await client.get(RUNTIME_TABLE, costKey(sub));
  return { spentMicros: micros(row?.spentMicros), committedMicros: micros(row?.committedMicros) };
}

/** No new turn fits: what `account.usage` reports as the agent budget spent. */
export function isCostExhausted(cost: Pick<GuestCost, "committedMicros">): boolean {
  return cost.committedMicros > COST_CAP_MICROS - COST_HOLD_MICROS;
}

/** What a turn does with its hold when it closes; each method acts once, later calls do nothing. */
export interface TurnCostHold {
  /** The model ran and reported its usage: the hold becomes the turn's real cost. */
  settle(usage: TurnTokens): Promise<void>;
  /** The model ran and reported nothing: the hold stays as the turn's cost. */
  keep(): Promise<void>;
  /** The model never ran: the hold goes back. */
  release(): Promise<void>;
}

export const NO_HOLD: TurnCostHold = { settle: async () => undefined, keep: async () => undefined, release: async () => undefined };

export type CostDecision = { readonly allowed: true; readonly hold: TurnCostHold } | { readonly allowed: false; readonly reason: "EXHAUSTED" | "NO_OWNER" };

export interface TurnCostLedger {
  /** Takes the hold of one turn of the operation's world, or refuses it. */
  hold(operation: Pick<Operation, "firmId" | "clockId">, log: Logger): Promise<CostDecision>;
}

export interface TurnCostDeps {
  readonly client: TableClient;
  /** Real time: only stamps the rows. */
  readonly now: () => Date;
}

function isConflict(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === "CONFLICT";
}

async function addTo(deps: TurnCostDeps, sub: string, add: Readonly<Record<string, number>>, condition?: { readonly atMost: { readonly attribute: string; readonly value: number } }): Promise<void> {
  await deps.client.update(RUNTIME_TABLE, costKey(sub), { add, setIfAbsent: { entity: ENTITY, sub } }, deps.now().toISOString(), { upsert: true, ...(condition === undefined ? {} : { condition }) });
}

function holdOf(deps: TurnCostDeps, sub: string, log: Logger): TurnCostHold {
  let closed = false;
  const close = async (what: string, add: Readonly<Record<string, number>>): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await addTo(deps, sub, add);
    } catch (error) {
      // The hold stays charged: a failed close errs on the side of the cap, never of the spend.
      log.error("turn_cost.close_failed", { what, error: error instanceof Error ? error.name : "unknown" });
    }
  };
  return {
    settle: async (usage) => {
      const cost = guestTurnCostMicros(usage);
      await close("settle", { committedMicros: cost - COST_HOLD_MICROS, spentMicros: cost, turns: 1 });
    },
    keep: async () => close("keep", { spentMicros: COST_HOLD_MICROS, turns: 1 }),
    release: async () => close("release", { committedMicros: -COST_HOLD_MICROS }),
  };
}

export function createTurnCostLedger(deps: TurnCostDeps): TurnCostLedger {
  return {
    async hold(operation, log) {
      const owner = await costOwnerOf(deps.client, operation);
      if (owner.kind === "INTERNAL") return { allowed: true, hold: NO_HOLD };
      if (owner.kind === "ORPHAN") {
        log.warn("turn_cost.no_owner", { firmId: operation.firmId });
        return { allowed: false, reason: "NO_OWNER" };
      }
      try {
        await addTo(deps, owner.sub, { committedMicros: COST_HOLD_MICROS }, { atMost: { attribute: "committedMicros", value: COST_CAP_MICROS - COST_HOLD_MICROS } });
      } catch (error) {
        if (!isConflict(error)) throw error;
        return { allowed: false, reason: "EXHAUSTED" };
      }
      return { allowed: true, hold: holdOf(deps, owner.sub, log) };
    },
  };
}
