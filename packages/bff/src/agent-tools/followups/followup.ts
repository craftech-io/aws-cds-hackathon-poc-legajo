// `schedule_followup` (docs/tool-catalog.md, FL-027): the agent's own follow-up of an operation, a
// `TIMER#FOLLOWUP_DUE#<followupId>` (with its schedule when the world runs). Rules, in code:
//
//   - at most two open (SCHEDULED) follow-ups per operation (`CONFLICT`, FOLLOWUP_LIMIT);
//   - the instant moves to the party's next business opening (`CP-HOURS-AR` for the importer, with
//     Argentina's national holidays; `CP-HOURS-SUPPLIER` in the supplier's zone), and `adjustedBy` says so;
//   - never at or after the `ESCALATION` milestone (`INVALID`, FOLLOWUP_AFTER_ESCALATION), nor in the past;
//   - the timer remembers which documents were pending and at which version, so it can tell when it
//     falls due whether they arrived (due.ts).
import { ConnectorError, type DocType, type RuleId, ToolError } from "@legajo/shared";
import type { Connector } from "../../connector/connector";
import { timerKeyOf } from "../../domain/timers";
import { ulid } from "../../lib/crypto";
import { type BusinessHours, argentinaBusinessHours, supplierBusinessHours, nextBusinessOpening, toZonedIso, zonedParts, ARGENTINA_TIME_ZONE } from "../../services/business-hours";
import { holidayCalendar } from "../../services/holidays";
import { type TimerDeps, armTimer } from "../../timers/timers";
import { milestoneDueTimes } from "../../milestones/schedule";
import type { FollowupReason } from "./schema";

/** At most this many open follow-ups per operation. */
export const MAX_OPEN_FOLLOWUPS = 2;

export const FOLLOWUP_REASON = {
  LIMIT: "FOLLOWUP_LIMIT",
  AFTER_ESCALATION: "FOLLOWUP_AFTER_ESCALATION",
  PAST: "FOLLOWUP_IN_THE_PAST",
} as const;

export interface FollowupInput {
  readonly operationId: string;
  readonly party: "IMPORTER" | "SUPPLIER";
  readonly atSim: string;
  readonly reason: FollowupReason;
  /** Simulated now of the call. */
  readonly nowSim: string;
}

export interface ScheduledFollowup {
  readonly followupId: string;
  readonly scheduledForSim: string;
  readonly scheduledForText: string;
  readonly adjustedBy: readonly RuleId[];
  readonly timerKey: string;
  readonly schedule: string;
}

export interface FollowupDeps extends TimerDeps {
  readonly data: Pick<Connector, "timers" | "world" | "operations" | "documents" | "parties" | "reference">;
}

/** The documents a follow-up waits for, with the version each one had. */
export interface PendingDocument {
  readonly docType: DocType;
  readonly version: number;
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "23/10 10:00" (importer, Argentina) or "Oct 23, 10:00 (Europe/Madrid)" (supplier, its zone). */
export function followupText(instant: Date, party: FollowupInput["party"], timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  const [, month = "01", day = "01"] = parts.date.split("-");
  if (party === "IMPORTER") return `${day}/${month} ${parts.time}`;
  return `${MONTHS_EN[Number(month) - 1] ?? month} ${Number(day)}, ${parts.time} (${timeZone})`;
}

async function hoursOf(party: FollowupInput["party"], supplierId: string, deps: FollowupDeps): Promise<{ readonly hours: BusinessHours; readonly rule: RuleId }> {
  if (party === "IMPORTER") {
    const rows = await deps.data.reference.listHolidays("AR");
    return { hours: argentinaBusinessHours(holidayCalendar("AR", rows.map((row) => row.date))), rule: "CP-HOURS-AR" };
  }
  const supplier = await deps.data.parties.getSupplier(supplierId);
  return { hours: supplierBusinessHours(supplier.timezone), rule: "CP-HOURS-SUPPLIER" };
}

export async function scheduleFollowup(input: FollowupInput, deps: FollowupDeps): Promise<ScheduledFollowup> {
  const operation = await deps.data.operations.getOperation(input.operationId);
  const requested = new Date(Date.parse(input.atSim));
  if (Number.isNaN(requested.getTime())) throw new ToolError("INVALID", "atSim is not an instant", "VALIDATION");
  if (requested.getTime() <= Date.parse(input.nowSim)) throw new ToolError("INVALID", "a follow-up is in the future", FOLLOWUP_REASON.PAST);
  const open = await deps.data.timers.listTimers(operation.operationId, { kind: "FOLLOWUP_DUE", status: "SCHEDULED" });
  if (open.length >= MAX_OPEN_FOLLOWUPS) throw new ToolError("CONFLICT", `at most ${MAX_OPEN_FOLLOWUPS} open follow-ups per operation`, FOLLOWUP_REASON.LIMIT);

  const { hours, rule } = await hoursOf(input.party, operation.supplierId, deps);
  const adjusted = nextBusinessOpening(requested, hours);
  const adjustedBy: RuleId[] = adjusted.getTime() === requested.getTime() ? [] : [rule];
  const escalation = await deps.data.timers.findTimer(operation.operationId, timerKeyOf("MILESTONE", "ESCALATION"));
  const escalationAt = Date.parse(escalation?.dueAtSim ?? milestoneDueTimes(operation.eta).ESCALATION);
  if (adjusted.getTime() >= escalationAt) {
    throw new ToolError("INVALID", `a follow-up falls before the ESCALATION milestone (${toZonedIso(new Date(escalationAt), ARGENTINA_TIME_ZONE)})`, FOLLOWUP_REASON.AFTER_ESCALATION);
  }

  const documents = await deps.data.documents.listDocuments(operation.operationId);
  const pending: PendingDocument[] = documents.filter((document) => document.status !== "VALID").map((document) => ({ docType: document.docType, version: document.currentVersion }));
  const followupId = `fu-${ulid(deps.realClock().getTime()).toLowerCase()}`;
  const scheduledForSim = toZonedIso(adjusted, hours.timeZone);
  try {
    const armed = await armTimer(
      {
        operationId: operation.operationId,
        clockId: operation.clockId,
        kind: "FOLLOWUP_DUE",
        timerId: followupId,
        dueAtSim: scheduledForSim,
        reason: input.reason,
        payload: { party: input.party, reason: input.reason, requestedAtSim: input.atSim, adjustedBy, pending },
      },
      deps,
    );
    return { followupId, scheduledForSim, scheduledForText: followupText(adjusted, input.party, hours.timeZone), adjustedBy, timerKey: timerKeyOf("FOLLOWUP_DUE", followupId), schedule: armed.schedule };
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") throw new ToolError("CONFLICT", "that follow-up already exists", "FOLLOWUP_EXISTS");
    throw error;
  }
}
