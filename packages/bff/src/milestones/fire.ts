// `fire_milestone` (docs/tool-catalog.md, docs/design-brief.md §5.1): the action of a due
// `TIMER#MILESTONE#<name>`, run inside `fire_timer` (timers/fire.ts claims the timer, audits
// `MILESTONE_FIRED`/`MILESTONE_SKIPPED` once per version and settles it).
//
//   complete or approved dossier   SKIPPED, no turn (FL-008)
//   DOCS_REQUEST, FOLLOWUP,        an `AGENT_TURN(MILESTONE)` with the milestone and its timer; the turn
//   FOLLOWUP_FINAL                 decides the message (a failed DOCS_REQUEST turn falls back, fallback.ts)
//   ESCALATION                     deterministic, no turn: escalation.ts (FL-066)
//   ARRIVAL                        deterministic, no turn: arrival.ts (FL-071)
//
// A dispatch that is `LIBERADO` already cancelled the timers (`notify_dispatch_status`); one that slips
// through is skipped the same way.
import { MilestoneName } from "@legajo/shared";
import { timerTurnEvent } from "../timers/events";
import type { FiredTimer, TimerAction, TimerActionResult } from "../timers/fire";
import { arrivalMilestone } from "./arrival";
import { type MilestoneDeps, firingEventId } from "./deps";
import { skipReason } from "./dossier";
import { escalationMilestone } from "./escalation";

/** The milestones that open a turn of the agent; the other two are deterministic. */
export const TURN_MILESTONES: ReadonlySet<MilestoneName> = new Set(["DOCS_REQUEST", "FOLLOWUP", "FOLLOWUP_FINAL"]);

async function openTurn(fired: FiredTimer, milestone: MilestoneName, deps: Pick<MilestoneDeps, "sink">): Promise<TimerActionResult> {
  const { firing } = fired;
  const turn = timerTurnEvent({
    event: { ...firing, eventId: firingEventId(fired) },
    trigger: "MILESTONE",
    milestone,
  });
  await deps.sink.enqueue(turn);
  return { outcome: "FIRED", detail: { milestone, turnEventId: turn.eventId } };
}

/** The action of every `TIMER#MILESTONE#`. */
export function milestoneAction(deps: MilestoneDeps): TimerAction {
  return async (fired) => {
    const milestone = MilestoneName.parse(fired.timer.timerId);
    const operation = await deps.data.operations.getOperation(fired.timer.operationId);
    const documents = await deps.data.documents.listDocuments(operation.operationId);
    const skip = skipReason(operation, documents);
    if (skip !== undefined) return { outcome: "SKIPPED", reason: skip, detail: { milestone } };
    if (TURN_MILESTONES.has(milestone)) return openTurn(fired, milestone, deps);
    if (milestone === "ESCALATION") return escalationMilestone(fired, operation, deps);
    return arrivalMilestone(fired, operation, documents, deps);
  };
}
