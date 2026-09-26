// The world's demo clock as the shell sees it (ADR-0007, docs/architecture.md §7-§8): the answer of
// `clock.get` validated at the edge, how often the console asks again, and when the controls that
// move time open up. Pure functions over the snapshot and an injected real clock; the polling loop
// lives in context/WorldClockContext.tsx.
//
//   busy (turn, queued event, mail in transit, PDF scan)  → poll every 3 s, controls disabled with
//                                                           what the world waits for
//   busy for more than 5 real minutes                     → "Avanzar igual" (force: true)
//   quiet                                                 → poll every 15 s
import { ClockMode, IsoInstant, OperationNumber, PendingKind } from "@legajo/shared";
import { z } from "zod";
import { copy } from "../copy/console";

/** Something the world still waits for (`WORLD_BUSY` pendientes of docs/architecture.md §8). */
export const WorldPending = z.looseObject({
  kind: PendingKind,
  operationNumber: OperationNumber.nullish(),
  detail: z.string().nullish(),
  /** Real instant the wait started. */
  sinceReal: IsoInstant,
});
export type WorldPending = z.infer<typeof WorldPending>;

/** What the shell needs of `clock.get`; the clock view reads the rest of the answer (next events). */
export const ClockSnapshot = z.looseObject({
  clockId: z.string().min(1),
  mode: ClockMode,
  /** Simulated now of the world. */
  simNow: IsoInstant,
  /** RUNNING only: when the live clock falls back to PAUSED (real time). */
  runningUntilReal: IsoInstant.nullish(),
  busy: z.boolean(),
  pending: z.array(WorldPending),
});
export type ClockSnapshot = z.infer<typeof ClockSnapshot>;

/** Refresh cadence while something is in flight or the clock runs live (docs/architecture.md §10). */
export const POLL_BUSY_MS = 3_000;
/** Refresh cadence of a quiet world. */
export const POLL_IDLE_MS = 15_000;
/** "Avanzar igual" appears once the oldest pending is this old (the BFF checks it again). */
export const FORCE_AFTER_MS = 5 * 60_000;

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** A move of the clock from the shell: to the next timer of any kind, or by a fixed span. */
export type ClockMove = { readonly kind: "next" } | { readonly kind: "by"; readonly minutes: number };

export function isBusy(snapshot: ClockSnapshot): boolean {
  return snapshot.busy || snapshot.pending.length > 0;
}

export function pollDelayMs(snapshot: ClockSnapshot | undefined): number {
  if (!snapshot) return POLL_IDLE_MS;
  return isBusy(snapshot) || snapshot.mode === "RUNNING" ? POLL_BUSY_MS : POLL_IDLE_MS;
}

/** Pendings, the one that has waited longest first. */
export function pendingByAge(snapshot: ClockSnapshot): WorldPending[] {
  return [...snapshot.pending].sort((a, b) => Date.parse(a.sinceReal) - Date.parse(b.sinceReal));
}

/** How long the world has been waiting for its oldest pending; undefined when nothing is pending. */
export function oldestPendingAgeMs(snapshot: ClockSnapshot, nowMs: number): number | undefined {
  const oldest = pendingByAge(snapshot)[0];
  return oldest === undefined ? undefined : Math.max(0, nowMs - Date.parse(oldest.sinceReal));
}

/** True once the world has been busy for five real minutes: the shell offers "Avanzar igual". */
export function canForce(snapshot: ClockSnapshot, nowMs: number): boolean {
  if (!isBusy(snapshot)) return false;
  const age = oldestPendingAgeMs(snapshot, nowMs);
  return age !== undefined && age >= FORCE_AFTER_MS;
}

/** Milliseconds until "Avanzar igual" appears; undefined when the world is quiet or it is already there. */
export function forceAvailableInMs(snapshot: ClockSnapshot, nowMs: number): number | undefined {
  if (!isBusy(snapshot) || canForce(snapshot, nowMs)) return undefined;
  const age = oldestPendingAgeMs(snapshot, nowMs);
  return age === undefined ? undefined : FORCE_AFTER_MS - age;
}

/**
 * What the bar says while the world is busy, the pending that waited longest first:
 * "Esperando: email en tránsito por SES (~30 s) · operación 4471 · y 1 pendiente más".
 */
export function waitText(snapshot: ClockSnapshot): string | undefined {
  const [first, ...rest] = pendingByAge(snapshot);
  if (!first) return isBusy(snapshot) ? copy.clock.disabled : undefined;
  const parts: string[] = [copy.clock.pending[first.kind]];
  if (first.operationNumber) parts.push(copy.clock.operation(first.operationNumber));
  if (rest.length > 0) parts.push(copy.clock.more(rest.length));
  return parts.join(" · ");
}

/** Procedure and input of a move (`clock.advanceToNext` or `clock.advance`, docs/tool-catalog.md). */
export function moveRequest(move: ClockMove, force: boolean): { readonly path: string; readonly input: Readonly<Record<string, unknown>> } {
  const forced = force ? { force: true } : {};
  if (move.kind === "next") return { path: "clock.advanceToNext", input: forced };
  if (!Number.isInteger(move.minutes) || move.minutes <= 0 || move.minutes > 14 * MINUTES_PER_DAY) {
    throw new RangeError(`a clock move is 1 minute to 14 days, got ${move.minutes}`);
  }
  return { path: "clock.advance", input: { minutes: move.minutes, ...forced } };
}
