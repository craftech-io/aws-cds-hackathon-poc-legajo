// How close an operation is to its arrival with documents still missing, read on the world's
// simulated clock (ADR-0007), never the machine's. The threshold is the one of the KPI "% completos
// ≥ 72 h antes del arribo" (docs/design-brief.md §8): a dossier that is not complete 72 hours before
// the ETA is at risk. Complete means ready for review or approved, or its three documents valid.
import type { DocStatus, DossierStatus } from "@legajo/shared";

export type Risk = "AT_RISK" | "ON_TRACK" | "COMPLETE";

export const RISK_WINDOW_HOURS = 72;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export interface RiskInput {
  readonly dossierStatus: DossierStatus;
  readonly documents: readonly { readonly status: DocStatus }[];
  readonly eta: string;
}

function isDossierComplete(input: Pick<RiskInput, "dossierStatus" | "documents">): boolean {
  if (input.dossierStatus === "READY_FOR_REVIEW" || input.dossierStatus === "APPROVED") return true;
  return input.documents.length === 3 && input.documents.every((document) => document.status === "VALID");
}

/** Hours from `fromIso` to `toIso` (negative once `toIso` is in the past). */
function hoursBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / HOUR_MS;
}

/** Undefined until the world clock answered: without its simulated now nothing can be said. */
export function riskOf(input: RiskInput, simNow: string | undefined): Risk | undefined {
  if (isDossierComplete(input)) return "COMPLETE";
  if (simNow === undefined) return undefined;
  return hoursBetween(simNow, input.eta) <= RISK_WINDOW_HOURS ? "AT_RISK" : "ON_TRACK";
}

export interface TimeToEta {
  readonly arrived: boolean;
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
}

/** Whole days, hours and minutes from the simulated now to the ETA; `arrived` once it passed. */
export function timeToEta(eta: string, simNow: string): TimeToEta {
  const remaining = Date.parse(eta) - Date.parse(simNow);
  if (remaining <= 0) return { arrived: true, days: 0, hours: 0, minutes: 0 };
  return {
    arrived: false,
    days: Math.floor(remaining / DAY_MS),
    hours: Math.floor((remaining % DAY_MS) / HOUR_MS),
    minutes: Math.floor((remaining % HOUR_MS) / 60_000),
  };
}
