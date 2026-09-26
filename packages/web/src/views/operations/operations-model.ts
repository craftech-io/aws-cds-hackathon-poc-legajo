// The list of operations as the console shows it (docs/design-brief.md §6, row 1; FL-080): each row of
// `operations.list` with its time to arrival and risk on the world's simulated clock, its next event
// from `clock.get`, the 4471 pinned on top as the main story (§4) and the second-act stories named;
// the filters by dossier status, risk and ETA range, and how many rows each option would show.
import { DossierStatus, IsoInstant, OperationNumber, TimerKind } from "@legajo/shared";
import { z } from "zod";
import { type EtaRangeBounds, etaInRange } from "../../lib/eta-range";
import { type Risk, type TimeToEta, riskOf, timeToEta } from "../dossier/risk";
import type { OperationRow } from "../dossier/types";

/** The operation every world tells first (docs/design-brief.md §4, docs/seed-spec.md §3). */
const MAIN_STORY_NUMBER = "4471";

/** The other stories of the list, each in its own operation and named in the console (§4). */
const SECOND_ACT_NUMBERS = ["4474", "4477", "4478", "4487", "4488"] as const;
export type SecondActNumber = (typeof SECOND_ACT_NUMBERS)[number];

/** How many upcoming events `clock.get` lists (NEXT_EVENTS_LIMIT of packages/bff/src/routers/clock.ts). */
export const CLOCK_NEXT_EVENTS_LIMIT = 5;

export const NextEvent = z.looseObject({
  operationNumber: OperationNumber,
  kind: TimerKind,
  timerId: z.string().min(1),
  dueAtSim: IsoInstant,
  reason: z.string().optional(),
});
export type NextEvent = z.infer<typeof NextEvent>;

const WithNextEvents = z.looseObject({ nextEvents: z.array(NextEvent) });

/** The world's next events, earliest first; `complete` when the list holds every scheduled one. */
export interface Upcoming {
  readonly events: readonly NextEvent[];
  readonly complete: boolean;
}

/** The upcoming events of a `clock.get` answer (the shell keeps it loose); undefined before it arrives. */
export function upcomingOf(snapshot: unknown): Upcoming | undefined {
  const parsed = WithNextEvents.safeParse(snapshot);
  if (!parsed.success) return undefined;
  const events = [...parsed.data.nextEvents].sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim));
  return { events, complete: events.length < CLOCK_NEXT_EVENTS_LIMIT };
}

/**
 * The next event of one operation: its own entry among the world's next events; else, when that list
 * is cut, "after the last one listed" (true, if not precise); else nothing is pending.
 */
export type NextEventCell =
  | { readonly kind: "event"; readonly event: NextEvent }
  | { readonly kind: "later"; readonly after: string }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

export function nextEventOf(operationNumber: string, upcoming: Upcoming | undefined): NextEventCell {
  if (upcoming === undefined) return { kind: "unknown" };
  const own = upcoming.events.find((event) => event.operationNumber === operationNumber);
  if (own) return { kind: "event", event: own };
  const last = upcoming.events.at(-1);
  if (!upcoming.complete && last) return { kind: "later", after: last.dueAtSim };
  return { kind: "none" };
}

export interface ListRow {
  readonly row: OperationRow;
  readonly risk: Risk | undefined;
  readonly toEta: TimeToEta | undefined;
  readonly next: NextEventCell;
  readonly mainStory: boolean;
  readonly secondAct: SecondActNumber | undefined;
}

function secondActOf(operationNumber: string): SecondActNumber | undefined {
  return SECOND_ACT_NUMBERS.find((number) => number === operationNumber);
}

/** Main story first, then by ETA (the one arriving first on top), then by number. */
function compareRows(a: ListRow, b: ListRow): number {
  if (a.mainStory !== b.mainStory) return a.mainStory ? -1 : 1;
  const byEta = Date.parse(a.row.eta) - Date.parse(b.row.eta);
  if (byEta !== 0) return byEta;
  return a.row.operationNumber.localeCompare(b.row.operationNumber);
}

/** The rows of the table, read against the world's simulated now (undefined until the clock answers). */
export function listRows(operations: readonly OperationRow[], simNow: string | undefined, upcoming: Upcoming | undefined): ListRow[] {
  return operations
    .map((row) => ({
      row,
      risk: riskOf(row, simNow),
      toEta: simNow === undefined ? undefined : timeToEta(row.eta, simNow),
      next: nextEventOf(row.operationNumber, upcoming),
      mainStory: row.operationNumber === MAIN_STORY_NUMBER,
      secondAct: secondActOf(row.operationNumber),
    }))
    .sort(compareRows);
}

export type StatusFilter = "ALL" | DossierStatus;
export type RiskFilter = "ALL" | Risk;

export const STATUS_FILTERS: readonly StatusFilter[] = ["ALL", ...DossierStatus.options];
export const RISK_FILTERS: readonly RiskFilter[] = ["ALL", "AT_RISK", "ON_TRACK", "COMPLETE"];

export interface ListFilters {
  readonly status: StatusFilter;
  readonly risk: RiskFilter;
  readonly eta: EtaRangeBounds;
}

export const NO_FILTERS: ListFilters = { status: "ALL", risk: "ALL", eta: {} };

function statusMatches(row: ListRow, status: StatusFilter): boolean {
  return status === "ALL" || row.row.dossierStatus === status;
}

function riskMatches(row: ListRow, risk: RiskFilter): boolean {
  return risk === "ALL" || row.risk === risk;
}

function matchesFilters(row: ListRow, filters: ListFilters): boolean {
  return statusMatches(row, filters.status) && riskMatches(row, filters.risk) && etaInRange(row.row.eta, filters.eta);
}

export function applyFilters(rows: readonly ListRow[], filters: ListFilters): ListRow[] {
  return rows.filter((row) => matchesFilters(row, filters));
}

/** Rows each status option would show with the other filters as they are. */
export function statusCounts(rows: readonly ListRow[], filters: ListFilters): Readonly<Record<StatusFilter, number>> {
  const others = rows.filter((row) => riskMatches(row, filters.risk) && etaInRange(row.row.eta, filters.eta));
  return Object.fromEntries(STATUS_FILTERS.map((status) => [status, others.filter((row) => statusMatches(row, status)).length])) as Record<StatusFilter, number>;
}

/** Rows each risk option would show with the other filters as they are. */
export function riskCounts(rows: readonly ListRow[], filters: ListFilters): Readonly<Record<RiskFilter, number>> {
  const others = rows.filter((row) => statusMatches(row, filters.status) && etaInRange(row.row.eta, filters.eta));
  return Object.fromEntries(RISK_FILTERS.map((risk) => [risk, others.filter((row) => riskMatches(row, risk)).length])) as Record<RiskFilter, number>;
}
