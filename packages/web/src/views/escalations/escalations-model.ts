// The escalations inbox (docs/design-brief.md §6, row 3): the open escalations of the world grouped by
// reason (§5.8), oldest first, each with how long it has been open on the world's simulated clock.
import { EscalationReason } from "@legajo/shared";
import type { EscalationsList } from "../dossier/types";

export type EscalationRow = EscalationsList["escalations"][number];

export type ReasonFilter = "ALL" | EscalationReason;

/** Oldest first: the one waiting longest for the firm goes on top. */
export function byAge(rows: readonly EscalationRow[]): EscalationRow[] {
  return [...rows].sort((a, b) => Date.parse(a.openedAtSim) - Date.parse(b.openedAtSim) || a.escalationId.localeCompare(b.escalationId));
}

export function filterByReason(rows: readonly EscalationRow[], reason: ReasonFilter): EscalationRow[] {
  return reason === "ALL" ? [...rows] : rows.filter((row) => row.reason === reason);
}

export interface ReasonCount {
  readonly reason: ReasonFilter;
  readonly count: number;
}

/** "Todos" and every reason with at least one open escalation, in the order of §5.8. */
export function reasonCounts(rows: readonly EscalationRow[]): ReasonCount[] {
  const present = EscalationReason.options
    .map((reason) => ({ reason, count: rows.filter((row) => row.reason === reason).length }))
    .filter((entry) => entry.count > 0);
  return [{ reason: "ALL", count: rows.length }, ...present];
}

/** A filter that no longer has rows (the last one was resolved) falls back to "Todos". */
export function effectiveReason(rows: readonly EscalationRow[], reason: ReasonFilter): ReasonFilter {
  return reason === "ALL" || rows.some((row) => row.reason === reason) ? reason : "ALL";
}

export interface OpenFor {
  readonly days: number;
  readonly hours: number;
}

/** Simulated time an escalation has been open; undefined until the world clock answered. */
export function openFor(openedAtSim: string, simNow: string | undefined): OpenFor | undefined {
  if (simNow === undefined) return undefined;
  const elapsed = Math.max(0, Date.parse(simNow) - Date.parse(openedAtSim));
  const hours = Math.floor(elapsed / 3_600_000);
  return { days: Math.floor(hours / 24), hours: hours % 24 };
}
